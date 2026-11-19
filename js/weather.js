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
  storm:  { name: 'Gewitter', cover: 2.2, fog: 0.35, wet: 1,   rain: 1.4, light: 0.28, grey: 0.9, bolts: [2.5, 7] },
  snow:   { name: 'Schnee',   cover: 1.8, fog: 0.45, wet: 0.25, rain: 0, snow: 1, light: 0.75, grey: 0.5 },
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
    this.rainU = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: B }, uVel: { value: new THREE.Vector3(1.5, -17, 0.8) }, uAlpha: { value: 0 }, uLen: { value: 0.75 }, uCol: { value: new THREE.Color(0.75, 0.82, 0.9) } };
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: this.rainU,
      vertexShader: `attribute float aEnd; uniform float uTime; uniform vec3 uCam; uniform float uBox; uniform vec3 uVel; uniform float uLen;
        void main(){ vec3 p = position + uVel * uTime; p = mod(p - uCam + uBox * 0.5, uBox) + uCam - uBox * 0.5;
          p.x += sin(uTime * 1.3 + position.y * 0.7) * 0.6 * step(uLen, 0.2);   // Schneeflocken taumeln
          p -= normalize(uVel) * aEnd * uLen; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
      fragmentShader: `uniform float uAlpha; uniform vec3 uCol; void main(){ gl_FragColor = vec4(uCol, uAlpha); }`,
    });
    this.drops = new THREE.LineSegments(g, mat);
    this.drops.frustumCulled = false; this.drops.visible = false; this.drops.renderOrder = 7;
    game.scene.add(this.drops);
    // Blitzstrahl (gezackte Linie vom Himmel zum Boden), nur während des Blitzes sichtbar
    this.boltGeo = new THREE.BufferGeometry(); this.boltGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(40 * 3), 3));
    this.bolt = new THREE.Line(this.boltGeo, new THREE.LineBasicMaterial({ color: 0xe8f0ff, transparent: true, opacity: 0, toneMapped: false }));
    this.bolt.frustumCulled = false; this.bolt.renderOrder = 8; game.scene.add(this.bolt);
  }

  /** Neuen Blitz ein Stück vor der Kamera erzeugen. */
  makeBolt(camPos, camDir) {
    const a = Math.atan2(camDir.z, camDir.x) + (Math.random() - 0.5) * 1.2, d = 350 + Math.random() * 700;
    let x = camPos.x + Math.cos(a) * d, z = camPos.z + Math.sin(a) * d;
    const g = this.g.world.sample(x, z), top = g + 420, arr = this.boltGeo.attributes.position.array;
    for (let i = 0; i < 40; i++) {
      const t = i / 39; x += (Math.random() - 0.5) * 22; z += (Math.random() - 0.5) * 22;
      arr[i * 3] = x; arr[i * 3 + 1] = top - t * (top - g); arr[i * 3 + 2] = z;
    }
    this.boltGeo.attributes.position.needsUpdate = true;
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
    this.drops.visible = W.rain > 0 || W.snow > 0;
    // Regen: lange bläuliche Striche; Schnee: kurze weiße, langsam fallende Flocken
    const u = this.rainU;
    if (W.snow) { u.uVel.value.set(0.6, -1.6, 0.3); u.uLen.value = 0.14; u.uCol.value.setRGB(1, 1, 1); }
    else { u.uVel.value.set(1.5, -17 * (W.rain > 1 ? 1.2 : 1), 0.8 + (W.rain > 1 ? 3 : 0)); u.uLen.value = 0.75; u.uCol.value.setRGB(0.75, 0.82, 0.9); }
    g.world.setSnow?.(W.snow || 0);
    // Talnebel: morgens/abends und bei Nebel sichtbar über dem See, am Tag bei Sonne kaum
    if (g.world.valleyFogMat) { const vf = g.world.valleyFogMat; vf.opacity = type === 'fog' ? 0.85 : g.timeOfDay === 'dusk' ? 0.7 : g.timeOfDay === 'night' ? 0.25 : type === 'rain' || type === 'storm' ? 0.5 : 0.2; vf.color.set(g.timeOfDay === 'dusk' ? 0xffd2b8 : g.timeOfDay === 'night' ? 0x3a4660 : 0xe8eef4); }
    if (g.grass?.mesh) g.grass.mesh.visible = !W.snow && (g.fxLevel || 0) < 1;   // Gras liegt unter dem Schnee
    g.world.setCloudShadow?.(type === 'clear' ? 0.22 : type === 'cloudy' ? 0.38 : 0);
    if (g.mountains) g.mountains.visible = W.fog > 0.3;
  }

  update(dt, camPos, v) {
    const g = this.g, W = this.W;
    this.rain = damp(this.rain, W.rain, 1.5, dt);
    const u = this.rainU;
    u.uTime.value += dt; u.uCam.value.copy(camPos);
    this.snow = damp(this.snow || 0, W.snow || 0, 1.5, dt);
    u.uAlpha.value = 0.38 * Math.min(1, this.rain) + 0.85 * this.snow;
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
        const B = W.bolts || [9, 25];
        this.nextBolt = B[0] + Math.random() * (B[1] - B[0]); this.flash = 1;
        this.makeBolt(camPos, this.g.camera.getWorldDirection(this._cd || (this._cd = new THREE.Vector3())));
        const dist = 0.6 + Math.random() * 3;
        setTimeout(() => this.thunder(1 / dist), dist * 1000);
      }
      this.flash = Math.max(0, this.flash - dt * 4);
      const f = this.flash > 0.5 ? 1 : this.flash > 0.25 ? 0 : this.flash * 3;
      g.env.hemi.intensity = this.baseHemi + f * 2.5;
      g.env.sun.intensity = this.baseSun + f * 1.5;
      this.bolt.material.opacity = this.flash > 0.25 ? 1 : 0;
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
  // Zwei Ketten: nahe, bewaldete Vorberge und dahinter hohe, zerklüftete Gipfel mit Schnee.
  // Echte Flächen (mehrere Höhenreihen) mit Licht → Grate und Täler sind sichtbar; Dunst nach hinten.
  const grp = new THREE.Group();
  const hazeCol = new THREE.Color(0x9fb3c6);
  const layer = (R, depth, segs, rows, hMax, hBase, seed, forest, haze) => {
    const pos = [], col = [], idx = [];
    const rock = new THREE.Color(0x6b6d70), snow = new THREE.Color(0xf2f5f8), wood = new THREE.Color(0x2c4426), meadow = new THREE.Color(0x5d7a3a);
    const c = new THREE.Color();
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;                                     // 0 = vorderer Fuß, 1 = hinterer Kamm
        const rr = R + t * depth + fbm(a * 5, t * 2, 2, seed) * depth * 0.25;
        // ridged noise: scharfe Grate
        const n = 1 - Math.abs(fbm(ca * 4 + seed, sa * 4 + t * 1.5, 5, seed + 1));
        const peak = Math.pow(Math.max(0, n), 1.6) * hMax + Math.max(0, fbm(a * 9, t * 3, 3, seed + 2)) * hMax * 0.35;
        const prof = Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.5);          // vorne flach ansteigend
        const h = hBase + peak * prof;
        pos.push(ca * rr, h, sa * rr);
        // Farbe: unten Wald/Wiese, oben Fels, Gipfel Schnee
        const rel = h / (hBase + hMax);
        if (forest) c.copy(meadow).lerp(wood, smoothstep(0.1, 0.35, rel)).lerp(rock, smoothstep(0.55, 0.85, rel));
        else c.copy(wood).lerp(rock, smoothstep(0.2, 0.45, rel));
        c.lerp(snow, smoothstep(forest ? 0.9 : 0.55, forest ? 1.0 : 0.72, rel + fbm(a * 20, t * 5, 2, seed + 3) * 0.08));
        c.lerp(hazeCol, Math.min(0.85, haze + t * 0.15));
        col.push(c.r, c.g, c.b);
      }
    }
    const W = rows + 1;
    for (let i = 0; i < segs; i++) for (let r = 0; r < rows; r++) {
      const k = i * W + r; idx.push(k, k + W, k + 1, k + 1, k + W, k + W + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, flatShading: true });
    mat.emissive.setScalar(0.35); mat.emissiveIntensity = 1;   // Schattenseiten nicht schwarz (Streulicht der Atmosphäre)
    mat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance *= vColor.rgb;'); };
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false; m.renderOrder = -0.5;
    // Vorhang nach unten, damit keine Lücke zum Gelände sichtbar ist
    grp.add(m);
  };
  layer(2300, 450, 260, 6, 160, -40, 31, true, 0.5);      // Vorberge mit Wald (Luftperspektive: bläulicher Dunst)
  layer(2900, 600, 300, 8, 520, 40, 77, false, 0.62);     // Hochgebirge mit Schnee
  grp.userData.setTint = () => {};
  return grp;
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
    // Unterholz im Wald: Farne (fächerförmige Wedel) und umgestürzte, bemooste Stämme
    {
      const S = 256, cv = document.createElement('canvas'); cv.width = 64; cv.height = S; const c = cv.getContext('2d');
      c.strokeStyle = '#3f5f22'; c.lineWidth = 2; c.beginPath(); c.moveTo(32, S); c.lineTo(32, 6); c.stroke();
      for (let y = 12; y < S - 6; y += 7) {                     // Fiederblättchen links/rechts, nach oben kürzer
        const L = 26 * (1 - y / S) ** 0.3 * Math.min(1, (S - y) / 30), g = 70 + (y / S) * 40;
        c.fillStyle = `rgb(${40 + y / S * 30},${g + 30},${30})`;
        for (const sd of [-1, 1]) { c.beginPath(); c.ellipse(32 + sd * L / 2, y, L / 2, 3, sd * -0.35, 0, 6.3); c.fill(); }
      }
      const ft = new THREE.CanvasTexture(cv); ft.colorSpace = THREE.SRGBColorSpace;
      const fparts = [];
      for (let k = 0; k < 7; k++) {
        const g = new THREE.PlaneGeometry(0.32, 1.1).translate(0, 0.55, 0).rotateX(-0.9 - rng() * 0.35).rotateY(k / 7 * Math.PI * 2 + rng() * 0.3);
        fparts.push(g.toNonIndexed());
      }
      const fg = new THREE.BufferGeometry(); const cnt = fparts.reduce((a2, g2) => a2 + g2.attributes.position.count, 0);
      for (const key of ['position', 'normal', 'uv']) { const sz = key === 'uv' ? 2 : 3, arr = new Float32Array(cnt * sz); let o = 0; for (const g2 of fparts) { arr.set(g2.attributes[key].array, o); o += g2.attributes[key].array.length; } fg.setAttribute(key, new THREE.BufferAttribute(arr, sz)); }
      { const n = fg.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, n.getX(i) * 0.3, 0.95, n.getZ(i) * 0.3); }
      this.ferns = new THREE.InstancedMesh(fg, new THREE.MeshStandardMaterial({ map: ft, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85 }), this.cap);
      const log = gradientColors(new THREE.CylinderGeometry(0.22, 0.28, 5, 9, 1).rotateZ(Math.PI / 2), [0.22, 0.17, 0.12], [0.3, 0.36, 0.18], -0.25, 0.3);
      this.logs = new THREE.InstancedMesh(mergeParts([{ geo: log }]), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), Math.max(1, Math.round(this.cap / 6)));
      for (const im of [this.ferns, this.logs]) { im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.count = 0; im.frustumCulled = false; im.castShadow = q.shadows; im.receiveShadow = true; scene.add(im); }
    }
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._e = new THREE.Euler(); this._c = new THREE.Color();
  }

  update(cam) {
    if (!this.cap || cam.distanceToSquared(this.last) < 400) return;
    this.last.copy(cam);
    const w = this.w, C = this.cell, R = this.R, C0 = WORLD_CITY_BOUNDS(w);
    let nr = 0, nb = 0, nf = 0, nl = 0;
    for (let j = Math.floor((cam.z - R) / C); j <= Math.floor((cam.z + R) / C); j++) {
      for (let i = Math.floor((cam.x - R) / C); i <= Math.floor((cam.x + R) / C); i++) {
        if (nr + nb >= this.cap * 2 - 2 && nf >= this.cap) break;
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
        const pBush = su === 2 ? 0.34 : su === 0 ? 0.07 : 0;
        // Wald: zusätzlich Farne (dicht) und gelegentlich ein umgestürzter Stamm
        if (su === 2) {
          const f1 = hash2(i, j, 304) * 0.5 + 0.5, f2 = hash2(i, j, 305) * 0.5 + 0.5;
          if (f1 < 0.7 && nf < this.ferns.count + this.cap && nf < this.cap) {
            for (let k = 0; k < 2 && nf < this.cap; k++) {
              const fx = x + (f2 - 0.5) * 5 + k * 1.7, fz = z + (f1 - 0.5) * 5 - k * 1.3, fs = 0.7 + ((f1 * 7 + k) % 1) * 0.7;
              this._e.set(0, f2 * 6.28 + k, 0);
              this._m.compose(this._p.set(fx, w.sample(fx, fz) - 0.05, fz), this._q.setFromEuler(this._e), this._s.set(fs, fs, fs));
              this.ferns.setMatrixAt(nf++, this._m);
            }
          }
          if (f2 > 0.93 && nl < this.logs.instanceMatrix.count) {
            this._e.set(0, f1 * 6.28, (f2 - 0.95) * 2);
            this._m.compose(this._p.set(x, y + 0.15, z), this._q.setFromEuler(this._e), this._s.set(0.8 + f1 * 0.6, 1, 1));
            this.logs.setMatrixAt(nl++, this._m);
          }
        }
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
    this.rocks.count = nr; this.bushes.count = nb; this.ferns.count = nf; this.logs.count = nl;
    this.ferns.instanceMatrix.needsUpdate = true; this.logs.instanceMatrix.needsUpdate = true;
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
