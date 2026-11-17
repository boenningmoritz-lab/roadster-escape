import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { clamp, lerp, damp, smoothstep, Settings } from './config.js';
import { hash2, mulberry32, fbm } from './world/noise.js';
import { mergeUV, mergeParts, gradientColors, jitter, radialTexture } from './world/world.js';

// ============================== Wetter ==============================
/**
 * Sonnig, bewölkt, Regen, Nebel. Regen: Tropfen-Streifen um die Kamera
 * (auf der Grafikkarte animiert), nasse, spiegelnde Straßen, weniger Grip,
 * Gischt hinter den Reifen, Regenrauschen, Blitz und Donner.
 */
const WEATHER = {
  clear:  { name: 'Sonnig',   cover: 1.0, fog: 1.0,  wet: 0,   rain: 0, light: 1.0,  grey: 0 },
  cloudy: { name: 'Bewölkt',  cover: 1.7, fog: 0.75, wet: 0,   rain: 0, light: 0.55, grey: 0.45 },
  rain:   { name: 'Regen',    cover: 2.0, fog: 0.42, wet: 1,   rain: 1, light: 0.4,  grey: 0.75 },
  fog:    { name: 'Nebel',    cover: 1.4, fog: 0.16, wet: 0.35, rain: 0, light: 0.55, grey: 0.6 },
};

class Weather {
  constructor(game) {
    this.g = game; this.type = 'clear'; this.W = WEATHER.clear;
    this.wet = 0; this.rain = 0; this.flash = 0; this.nextBolt = 12;
    const q = game.q;
    // Regenstreifen: jede Linie hat Grundposition, wird im Shader fallen gelassen und um die Kamera „gewickelt“
    const N = q.rainDrops || 3000, B = 46;
    const pos = new Float32Array(N * 6), end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.random() * B, y = Math.random() * B, z = Math.random() * B;
      pos.set([x, y, z, x, y, z], i * 6); end[i * 2] = 0; end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.rainU = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: B }, uVel: { value: new THREE.Vector3(1.5, -17, 0.8) }, uAlpha: { value: 0 } };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: this.rainU,
      vertexShader: `attribute float aEnd; uniform float uTime; uniform vec3 uCam; uniform float uBox; uniform vec3 uVel;
        void main(){ vec3 p = position + uVel * uTime; p = mod(p - uCam + uBox * 0.5, uBox) + uCam - uBox * 0.5;
          p -= normalize(uVel) * aEnd * 0.75; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
      fragmentShader: `uniform float uAlpha; void main(){ gl_FragColor = vec4(0.75, 0.82, 0.9, uAlpha); }`,
    });
    this.drops = new THREE.LineSegments(g, mat);
    this.drops.frustumCulled = false; this.drops.visible = false; this.drops.renderOrder = 7;
    game.scene.add(this.drops);
  }

  apply(type) {
    const g = this.g, env = g.env, W = this.W = WEATHER[type] || WEATHER.clear;
    this.type = type;
    const night = g.timeOfDay === 'night';
    env.uniforms.uCover.value = W.cover;
    // Himmel grauer, Licht weicher, Nebel dichter
    const greyTop = new THREE.Color(night ? 0x05070b : 0x7d8792), greyHor = new THREE.Color(night ? 0x0b0e14 : 0xa9b0b8);
    env.uniforms.uTop.value.lerp(greyTop, W.grey);
    env.uniforms.uHorizon.value.lerp(greyHor, W.grey);
    env.sun.intensity *= W.light;
    env.hemi.intensity *= lerp(1, 0.85, W.grey);
    env.scene.fog.color.lerp(greyHor, W.grey);
    env.scene.fog.near *= W.fog; env.scene.fog.far *= W.fog;
    this.baseSun = env.sun.intensity; this.baseHemi = env.hemi.intensity;
    // Reflexionen passend zum neuen Himmel
    const old = env.scene.environment;
    env.scene.environment = env.pmrem.fromScene(env.envScene, 0.03).texture; old?.dispose?.();
    g.world.setWet(W.wet);
    this.drops.visible = W.rain > 0;
    if (g.mountains) g.mountains.visible = W.fog > 0.3;
  }

  update(dt, camPos, v) {
    const g = this.g, W = this.W;
    this.rain = damp(this.rain, W.rain, 1.5, dt);
    const u = this.rainU;
    u.uTime.value += dt; u.uCam.value.copy(camPos);
    u.uAlpha.value = 0.38 * this.rain;
    // Regengeräusch
    const s = g.sound;
    if (s.ctx && !this.noiseG && s.noiseBuf) {
      const src = s.ctx.createBufferSource(); src.buffer = s.noiseBuf; src.loop = true;
      const f = s.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1200;
      this.noiseG = s.ctx.createGain(); this.noiseG.gain.value = 0;
      src.connect(f).connect(this.noiseG).connect(s.master); src.start();
    }
    if (this.noiseG) this.noiseG.gain.setTargetAtTime(this.rain * 0.12, s.ctx.currentTime, 0.3);
    // Gischt hinter den Reifen auf nasser Straße
    if (W.wet > 0.5 && v.groundedCount > 2 && v.speed > 8) {
      const k = Math.min(1, v.speed / 40);
      for (const w of [v.wheels[2], v.wheels[3]]) if (w.grounded && Math.random() < k * 0.9) g.particles.emit('spray', w.contact.x, w.contact.y + 0.2, w.contact.z, v.vel.x * 0.35, 1.2, v.vel.z * 0.35, 1, 1);
    }
    // Blitz und Donner bei Regen
    if (W.rain > 0) {
      if ((this.nextBolt -= dt) <= 0) {
        this.nextBolt = 9 + Math.random() * 16; this.flash = 1;
        const dist = 0.6 + Math.random() * 3;
        setTimeout(() => this.thunder(1 / dist), dist * 1000);
      }
      this.flash = Math.max(0, this.flash - dt * 4);
      const f = this.flash > 0.5 ? 1 : this.flash > 0.25 ? 0 : this.flash * 3;
      g.env.hemi.intensity = this.baseHemi + f * 2.5;
      g.env.sun.intensity = this.baseSun + f * 1.5;
    }
  }

  thunder(strength) {
    const s = this.g.sound;
    if (!s.ctx || !s.on) return;
    const ctx = s.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = s.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 160;
    const gn = ctx.createGain(); gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(0.5 * strength + 0.1, t + 0.15); gn.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
    src.connect(f).connect(gn).connect(s.master); src.start(t); src.stop(t + 3.6);
  }
}

// ============================== Bergkulisse ==============================
/** Ring aus dunstigen Bergen weit hinter dem Kartenrand (kein Nebel, eigene Luftperspektive). */
function makeMountainRing() {
  const segs = 220, R = 3050, pos = [], col = [], idx = [];
  const far = new THREE.Color(0x8ea3b8), base = new THREE.Color(0x56677a), snow = new THREE.Color(0xe8eef4);
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a);
    const h = 170 + fbm(Math.cos(a) * 3 + 10, Math.sin(a) * 3, 5, 77) * 260 + Math.max(0, fbm(a * 6, 1, 3, 3)) * 160;
    const r2 = R + fbm(a * 4, 2, 2, 5) * 150;
    pos.push(x * (R + 300), -60, z * (R + 300), x * r2, h, z * r2);
    const top = base.clone().lerp(snow, smoothstep(330, 430, h)).lerp(far, 0.45);
    col.push(...far.clone().lerp(base, 0.3).toArray(), ...top.toArray());
    if (i < segs) { const k = i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
  m.frustumCulled = false; m.renderOrder = -0.5;
  return m;
}

// ============================== Felsen & Büsche ==============================
/** Felsbrocken und Büsche rund um die Kamera (Wiese, Waldboden, Hänge). */
class Scenery {
  constructor(world, scene, q) {
    this.w = world; this.cap = q.scenery || 0; this.R = q.sceneryRadius || 150; this.cell = 7;
    this.last = new THREE.Vector3(1e9, 0, 0);
    if (!this.cap) return;
    const rng = mulberry32(55);
    const rock = gradientColors(jitter(new THREE.IcosahedronGeometry(1, 1).scale(1, 0.62, 0.85), 0.35, rng), [0.33, 0.32, 0.3], [0.56, 0.55, 0.52], -0.6, 0.6);
    this.rocks = new THREE.InstancedMesh(mergeParts([{ geo: rock }]), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), this.cap);
    // Busch aus Laubkarten (gleiche Textur wie die Bäume)
    const parts = [];
    const remap = (gg, u0, u1, v0, v1) => { const uv = gg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0)); return gg; };
    parts.push({ geo: gradientColors(remap(jitter(new THREE.IcosahedronGeometry(0.7, 1).translate(0, 0.65, 0), 0.25, rng), 0, 0.1875, 0, 0.5), [0.4, 0.4, 0.4], [0.75, 0.75, 0.75], 0, 1.3) });
    for (let k = 0; k < 7; k++) {
      const p = new THREE.PlaneGeometry(1.5, 1.3); remap(p, 0.2, 0.6, 0, 1);
      const o = new THREE.Object3D(); o.position.set((rng() - 0.5) * 0.8, 0.75 + rng() * 0.3, (rng() - 0.5) * 0.8); o.rotation.set(rng() * 0.6, rng() * Math.PI, rng() * 0.4); o.updateMatrix();
      p.applyMatrix4(o.matrix);
      parts.push({ geo: gradientColors(p, [0.55, 0.55, 0.55], [1, 1, 1], 0, 1.5) });
    }
    this.bushes = new THREE.InstancedMesh(mergeUV(parts), world.treeMat, this.cap);
    for (const im of [this.rocks, this.bushes]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.count = 0; im.frustumCulled = false;
      im.castShadow = q.shadows; im.receiveShadow = true; scene.add(im);
    }
    this.bushes.setColorAt(0, new THREE.Color(1, 1, 1));
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._e = new THREE.Euler(); this._c = new THREE.Color();
  }

  update(cam) {
    if (!this.cap || cam.distanceToSquared(this.last) < 400) return;
    this.last.copy(cam);
    const w = this.w, C = this.cell, R = this.R, C0 = WORLD_CITY_BOUNDS(w);
    let nr = 0, nb = 0;
    for (let j = Math.floor((cam.z - R) / C); j <= Math.floor((cam.z + R) / C); j++) {
      for (let i = Math.floor((cam.x - R) / C); i <= Math.floor((cam.x + R) / C); i++) {
        if (nr + nb >= this.cap * 2 - 2) break;
        const h1 = hash2(i, j, 301) * 0.5 + 0.5, h2 = hash2(i, j, 302) * 0.5 + 0.5, h3 = hash2(i, j, 303) * 0.5 + 0.5;
        const x = (i + h1) * C, z = (j + h2) * C;
        if (Math.hypot(x - cam.x, z - cam.z) > R) continue;
        if (x > C0[0] && x < C0[1] && z > C0[2] && z < C0[3]) continue;
        const su = w.surfaceAt(x, z);
        if (su === 1) continue;
        const gi = Math.round((x + w.half) / w.cell), gj = Math.round((z + w.half) / w.cell);
        if (w.roadW[gj * w.n + gi] > 0.08) continue;
        const y = w.sample(x, z);
        if (y < w.waterLevel + 0.5) continue;
        const pRock = su === 4 ? 0.45 : su === 2 ? 0.1 : su === 3 ? 0.04 : 0.03;
        const pBush = su === 2 ? 0.28 : su === 0 ? 0.07 : 0;
        if (h3 < pRock && nr < this.cap) {
          const s = 0.35 + h2 * h2 * 1.8;
          this._e.set(h1 * 0.6, h2 * 6.28, h3 * 0.4);
          this._m.compose(this._p.set(x, y - s * 0.25, z), this._q.setFromEuler(this._e), this._s.set(s, s, s));
          this.rocks.setMatrixAt(nr++, this._m);
        } else if (h3 > 1 - pBush && nb < this.cap) {
          const s = 0.7 + h1 * 0.8;
          this._e.set(0, h2 * 6.28, 0);
          this._m.compose(this._p.set(x, y - 0.1, z), this._q.setFromEuler(this._e), this._s.set(s, s * (0.8 + h3 * 0.3), s));
          this.bushes.setMatrixAt(nb, this._m);
          this.bushes.setColorAt(nb++, this._c.setRGB(0.85 + h2 * 0.2, 0.9 + h1 * 0.15, 0.8));
        }
      }
    }
    this.rocks.count = nr; this.bushes.count = nb;
    this.rocks.instanceMatrix.needsUpdate = true; this.bushes.instanceMatrix.needsUpdate = true;
    if (this.bushes.instanceColor) this.bushes.instanceColor.needsUpdate = true;
  }
}
function WORLD_CITY_BOUNDS() { return [286, 1014, 136, 864]; }

// ============================== Straßenausstattung ==============================
function signTexture(kind) {
  const S = 256, cv = document.createElement('canvas'); cv.width = S; cv.height = kind === 'town' || kind === 'exit' ? 128 : S;
  const c = cv.getContext('2d'), H = cv.height;
  if (kind.startsWith('speed')) {
    c.fillStyle = '#fff'; c.beginPath(); c.arc(128, 128, 124, 0, 6.3); c.fill();
    c.strokeStyle = '#d0141e'; c.lineWidth = 30; c.beginPath(); c.arc(128, 128, 105, 0, 6.3); c.stroke();
    c.fillStyle = '#111'; c.font = 'bold 104px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(kind.slice(5), 128, 136);
  } else if (kind === 'town') {
    c.fillStyle = '#f6c90e'; c.fillRect(0, 0, S, H); c.strokeStyle = '#111'; c.lineWidth = 8; c.strokeRect(8, 8, S - 16, H - 16);
    c.fillStyle = '#111'; c.font = 'bold 46px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('Voltstadt', 128, 64);
  } else {
    c.fillStyle = '#1554a8'; c.fillRect(0, 0, S, H); c.strokeStyle = '#fff'; c.lineWidth = 5; c.strokeRect(6, 6, S - 12, H - 12);
    c.fillStyle = '#fff'; c.font = 'bold 30px sans-serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText('Ausfahrt', 22, 44); c.font = 'bold 34px sans-serif'; c.fillText('Voltstadt ↗', 22, 88);
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Leitpfosten mit Reflektoren, Tempo-Schilder, Ortsschilder, Autobahn-Wegweiser. */
function buildRoadFurniture(world, scene) {
  const posts = [], signs = { speed70: [], speed50: [], speed120: [], town: [], exit: [] };
  const place = (list, p, dir, off, h) => {
    const dx = p.tx * dir, dz = p.tz * dir, rx = -dz, rz = dx;
    list.push({ x: p.x + rx * off, z: p.z + rz * off, y: p.y, yaw: Math.atan2(-dx, -dz), h });
  };
  for (const e of world.edges) {
    if (e.cls === 'country') {
      for (let s = 25; s < e.len - 10; s += 50) {
        const p = world.pointOnEdge(e, s, {});
        for (const d of [1, -1]) place(posts, p, d, 5.1, 0);
      }
      for (const d of [1, -1]) {
        const startS = d > 0 ? 40 : e.len - 40;
        const startNode = d > 0 ? e.a : e.b;
        place(signs.speed70, world.pointOnEdge(e, startS, {}), d, 5.6, 2.2);
        if (startNode.type === 'city') {
          place(signs.town, world.pointOnEdge(e, d > 0 ? 18 : e.len - 18, {}), -d, 5.8, 2.0);
          place(signs.speed50, world.pointOnEdge(e, d > 0 ? 30 : e.len - 30, {}), -d, 5.6, 2.2);
        }
      }
    } else if (e.cls === 'highway') {
      for (let s = 300; s < e.len - 300; s += 1400) for (const d of [1, -1]) place(signs.speed120, world.pointOnEdge(e, s, {}), d, 12.6, 2.4);
      for (const d of [1, -1]) {
        const s = d > 0 ? e.len - 380 : 380;
        if (s > 0 && s < e.len) place(signs.exit, world.pointOnEdge(e, s, {}), d, 13.5, 3.2);
      }
    }
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  // Leitpfosten: weiß, schwarzer Streifen, Reflektor
  const postGeo = mergeParts([
    { geo: new THREE.BoxGeometry(0.12, 1.0, 0.1).translate(0, 0.5, 0), color: [0.93, 0.93, 0.9] },
    { geo: new THREE.BoxGeometry(0.125, 0.22, 0.105).translate(0, 0.76, 0), color: [0.08, 0.08, 0.08] },
  ]);
  const pm = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }), posts.length);
  const reflMat = new THREE.MeshBasicMaterial({ color: 0x553311, toneMapped: false });
  const rm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.13, 0.11).translate(0, 0.76, 0), reflMat, posts.length);
  posts.forEach((o, i) => { q.setFromAxisAngle(up, o.yaw); m.compose(p.set(o.x, world.sample(o.x, o.z), o.z), q, one); pm.setMatrixAt(i, m); rm.setMatrixAt(i, m); });
  pm.castShadow = true; scene.add(pm, rm);
  // Schilder
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.4 });
  const backMat = new THREE.MeshStandardMaterial({ color: 0x8a8f94, metalness: 0.5, roughness: 0.5 });
  const all = [];
  for (const [kind, list] of Object.entries(signs)) {
    if (!list.length) continue;
    const wide = kind === 'town' || kind === 'exit';
    const W = kind === 'exit' ? 3.2 : wide ? 1.6 : 0.85, H = kind === 'exit' ? 1.6 : wide ? 0.8 : 0.85;
    const face = new THREE.InstancedMesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: signTexture(kind), roughness: 0.45, emissive: 0xffffff, emissiveIntensity: 0, emissiveMap: null }), list.length);
    const back = new THREE.InstancedMesh(new THREE.PlaneGeometry(W, H).rotateY(Math.PI), backMat, list.length);
    list.forEach((o, i) => {
      q.setFromAxisAngle(up, o.yaw);
      m.compose(p.set(o.x, world.sample(o.x, o.z) + o.h, o.z), q, one); face.setMatrixAt(i, m);
      m.compose(p.set(o.x, world.sample(o.x, o.z) + o.h, o.z - 0.0), q, one); back.setMatrixAt(i, m);
      all.push([o.x, o.z, o.h - H / 2]);
    });
    face.castShadow = true; scene.add(face, back);
  }
  const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8).translate(0, 0.5, 0), poleMat, all.length);
  all.forEach(([x, z, h], i) => { m.makeScale(1, h, 1).setPosition(x, world.sample(x, z) - 0.02, z); pole.setMatrixAt(i, m); });
  pole.castShadow = true; scene.add(pole);
  return { setNight(on) { reflMat.color.set(on ? 0xffb050 : 0x553311); if (on) reflMat.color.multiplyScalar(2.2); } };
}

// ============================== Sonnenreflex ==============================
function makeSunFlare() {
  const tex = (inner, outer, size) => { const t = radialTexture(inner, outer); t.colorSpace = THREE.SRGBColorSpace; return [t, size]; };
  const lf = new Lensflare();
  const [glow] = tex('rgba(255,248,230,1)', 'rgba(255,220,160,0)', 0);
  const [ring] = tex('rgba(120,180,255,0.0)', 'rgba(120,180,255,0)', 0);
  lf.addElement(new LensflareElement(glow, 520, 0, new THREE.Color(1, 0.95, 0.85)));
  lf.addElement(new LensflareElement(glow, 60, 0.45, new THREE.Color(0.6, 0.8, 1)));
  lf.addElement(new LensflareElement(glow, 90, 0.7, new THREE.Color(0.7, 1, 0.8)));
  lf.addElement(new LensflareElement(glow, 140, 1.0, new THREE.Color(1, 0.75, 0.6)));
  void ring;
  lf.frustumCulled = false;
  return lf;
}

export { WEATHER, Weather, makeMountainRing, Scenery, buildRoadFurniture, makeSunFlare };
