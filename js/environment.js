import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clamp, smoothstep } from './config.js';
import { fbm } from './world/noise.js';
import { WORLD } from './world/world.js';
import { game } from './main.js';

// ============================== Environment (Tag/Nacht) ==============================
/**
 * Himmel (Verlauf, Sonne/Mond, Sterne, Wolken), Licht, Nebel, Umgebungs-
 * Reflexionen und – auf „Hoch“ – Bloom (Leuchten von Lichtern).
 */
class Environment {
  constructor(game) {
    this.g = game; this.scene = game.scene; this.renderer = game.renderer; this.q = game.q;
    this.hemi = new THREE.HemisphereLight(0xbfdcff, 0x5a6040, 0.9);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 3);
    this.sunDir = new THREE.Vector3(-0.5, 0.5, 0.42).normalize();
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0003; this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.scene.fog = new THREE.Fog(0xbcd6ea, 300, 2000);

    this.uniforms = {
      uTop: { value: new THREE.Color(0x2f6fd0) }, uHorizon: { value: new THREE.Color(0xbcd6ea) },
      uSunDir: { value: this.sunDir.clone() }, uNight: { value: 0 }, uTime: { value: 0 }, uClouds: { value: this.q.clouds ? 1 : 0 }, uCover: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.uniforms,
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform float uNight; uniform float uTime; uniform float uClouds; uniform float uCover;
        varying vec3 vDir;
        float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
        float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p *= 2.03; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vDir);
          float h = max(d.y, 0.0);
          vec3 col = mix(uHorizon, uTop, pow(h, 0.48));
          if (d.y < 0.0) col = mix(uHorizon, uHorizon * 0.6, clamp(-d.y * 4.0, 0.0, 1.0));
          float sd = max(dot(d, normalize(uSunDir)), 0.0);
          if (uNight < 0.5) {
            col += vec3(1.0, 0.92, 0.75) * (pow(sd, 1200.0) * 40.0 + pow(sd, 10.0) * 0.22 + pow(sd, 2.0) * 0.05);
          } else {
            col += vec3(0.85, 0.9, 1.0) * (smoothstep(0.99935, 0.9996, sd) * 3.0 + pow(sd, 80.0) * 0.08);
            vec2 sp = d.xz / (d.y + 0.35) * 260.0;
            float st = step(0.9968, h21(floor(sp))) * smoothstep(0.03, 0.25, d.y);
            col += vec3(st) * (0.55 + 0.45 * sin(uTime * 2.0 + h21(floor(sp) + 3.1) * 40.0));
          }
          if (uClouds > 0.0 && d.y > 0.0) {
            vec2 cp = d.xz / (d.y + 0.1) * 1.4 + vec2(uTime * 0.004, uTime * 0.0016);
            float cv = uCover - 1.0;
            float c = smoothstep(0.5 - 0.3 * cv, 0.82 - 0.12 * cv, fbm(cp));
            vec3 cc = uNight > 0.5 ? vec3(0.025, 0.03, 0.045) : mix(vec3(1.02), vec3(0.66, 0.7, 0.76), smoothstep(0.55, 0.95, fbm(cp * 1.8 + 3.0)));
            cc += (uNight > 0.5 ? 0.0 : 1.0) * vec3(0.25, 0.2, 0.1) * pow(sd, 6.0);
            cc *= 1.0 - 0.42 * clamp(cv, 0.0, 1.0);
            col = mix(col, cc, c * smoothstep(0.0, 0.16, d.y) * 0.92);
          }
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 32, 16), mat);
    this.sky.frustumCulled = false; this.sky.renderOrder = -1;
    this.scene.add(this.sky);
    this.envScene = new THREE.Scene();
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat));
    this.envGround = new THREE.Mesh(new THREE.CircleGeometry(9.5, 24).rotateX(-Math.PI / 2).translate(0, -1.2, 0), new THREE.MeshBasicMaterial({ color: 0x4a5236 }));
    this.envScene.add(this.envGround);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.composer = null;
  }

  /** Bloom-Nachbearbeitung (nur Grafikstufe „Hoch“). */
  setupBloom() {
    if (!this.q.bloom) { this.composer = null; return; }
    const r = this.renderer;
    const size = r.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.g.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.35, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.applyBloomParams();
  }
  applyBloomParams() {
    if (!this.bloom) return;
    this.bloom.strength = this.night ? 0.6 : 0.2;
    this.bloom.threshold = this.night ? 0.78 : 0.95;
    this.bloom.radius = this.night ? 0.55 : 0.4;
  }
  resize(w, h) { if (this.composer) { this.composer.setSize(w, h); this.composer.setPixelRatio(this.renderer.getPixelRatio()); } }

  setTime(mode) {
    const night = mode === 'night';
    this.night = night;
    const u = this.uniforms;
    u.uNight.value = night ? 1 : 0;
    if (night) {
      u.uTop.value.set(0x020610); u.uHorizon.value.set(0x0d1626);
      this.sunDir.set(0.35, 0.55, -0.55).normalize();              // Mond
      this.sun.color.set(0x9bb4ff); this.sun.intensity = 0.32;
      this.hemi.color.set(0x22324f); this.hemi.groundColor.set(0x08090b); this.hemi.intensity = 0.32;
      this.scene.fog.color.set(0x0a111c); this.scene.fog.near = 120; this.scene.fog.far = Math.min(1300, this.q.fogFar);
      this.renderer.toneMappingExposure = 1.15;
      this.envGround.material.color.set(0x050607);
    } else {
      u.uTop.value.set(0x2f6fd0); u.uHorizon.value.set(0xbcd6ea);
      this.sunDir.set(-0.5, 0.5, 0.42).normalize();
      this.sun.color.set(0xffe9cf); this.sun.intensity = 3.2;
      this.hemi.color.set(0xbfdcff); this.hemi.groundColor.set(0x5a6040); this.hemi.intensity = 0.85;
      this.scene.fog.color.set(0xbcd6ea); this.scene.fog.near = 300; this.scene.fog.far = this.q.fogFar;
      this.renderer.toneMappingExposure = 0.95;
      this.envGround.material.color.set(0x4a5236);
    }
    u.uSunDir.value.copy(this.sunDir);
    // Reflexionen aus dem aktuellen Himmel neu berechnen
    const old = this.scene.environment;
    this.scene.environment = this.pmrem.fromScene(this.envScene, 0.03).texture;
    this.scene.environmentIntensity = night ? 0.3 : 0.7;
    old?.dispose?.();
    this.applyBloomParams();
  }

  update(dt, focus, camPos) {
    this.uniforms.uTime.value += dt;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 200);
    this.sky.position.copy(camPos);
  }

  render(camera) {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, camera);
  }
}

// ============================== Minimap ==============================
/** Kleine, mitdrehende Karte oben links (Straßen, Wasser, Stadt, Verkehr). */
class Minimap {
  constructor(world) {
    this.w = world;
    this.el = document.getElementById('minimap');
    this.ctx = this.el.getContext('2d');
    const S = 512, half = world.half, k = S / (half * 2);
    this.k = k;
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const c = cv.getContext('2d');
    // Gelände (Farben aus dem Raster, abgedunkelt)
    const img = c.createImageData(S, S), d = img.data, n = world.n;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = Math.min(n - 1, Math.round(x / S * (n - 1))), j = Math.min(n - 1, Math.round(y / S * (n - 1)));
      const idx = j * n + i, p = (y * S + x) * 4;
      if (world.H[idx] < world.waterLevel) { d[p] = 40; d[p + 1] = 90; d[p + 2] = 130; }
      else { d[p] = world.col[idx * 3] * 0.55; d[p + 1] = world.col[idx * 3 + 1] * 0.55; d[p + 2] = world.col[idx * 3 + 2] * 0.55; }
      d[p + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    const tx = (x) => (x + half) * k;
    c.fillStyle = 'rgba(60,62,66,1)';
    for (const b of world.buildings) c.fillRect(tx(b.x0), tx(b.z0), (b.x1 - b.x0) * k, (b.z1 - b.z0) * k);
    const A = WORLD.air; c.fillStyle = '#55575b'; c.fillRect(tx(A.cx - A.hx), tx(A.cz - 30), A.hx * 2 * k, 60 * k);
    const draw = (cls, width, color) => {
      c.strokeStyle = color; c.lineWidth = width; c.lineJoin = 'round'; c.lineCap = 'round';
      for (const e of world.edges) {
        if (e.cls !== cls) continue;
        c.beginPath(); e.pts.forEach((p, i) => (i ? c.lineTo(tx(p.x), tx(p.z)) : c.moveTo(tx(p.x), tx(p.z)))); c.stroke();
      }
    };
    draw('city', 2, '#c9c9c9'); draw('country', 2.2, '#e8dcc0'); draw('highway', 3.4, '#f0a640');
    this.map = cv;
    this.t = 0;
  }

  draw(dt, vehicle, traffic) {
    if ((this.t -= dt) > 0) return;
    this.t = 0.07;
    const c = this.ctx, Wd = this.el.width, R = Wd / 2;
    const half = this.w.half, k = this.k;
    const zoom = 2.6;                        // Kartenpixel → Minimap-Pixel
    c.clearRect(0, 0, Wd, Wd);
    c.save();
    c.beginPath(); c.arc(R, R, R - 2, 0, Math.PI * 2); c.clip();
    c.fillStyle = '#10141a'; c.fillRect(0, 0, Wd, Wd);
    c.translate(R, R);
    c.rotate(vehicle.yaw());
    c.scale(zoom, zoom);
    c.translate(-(vehicle.pos.x + half) * k, -(vehicle.pos.z + half) * k);
    c.drawImage(this.map, 0, 0);
    c.fillStyle = '#ffffff';
    if (traffic) for (const car of traffic.cars) c.fillRect((car.x + half) * k - 0.7, (car.z + half) * k - 0.7, 1.4, 1.4);
    const ms = window.__game?.missions;
    if (ms && !ms.active) for (const mk of ms.markers) if (mk.grp.visible) { c.fillStyle = '#ffc13b'; c.fillRect((mk.p.x + half) * k - 2.2, (mk.p.z + half) * k - 2.2, 4.4, 4.4); }
    const pol = window.__game?.police;
    if (pol?.active) {
      const blink = (pol.time * 4 | 0) % 2;
      for (const u of pol.units) if (u.active) { c.fillStyle = blink ? '#3d6bff' : '#ff3b4e'; c.beginPath(); c.arc((u.pos.x + half) * k, (u.pos.z + half) * k, 2.2, 0, 6.3); c.fill(); }
      if (pol.heli && pol.D.heli) { c.strokeStyle = '#ffd23f'; c.lineWidth = 1; c.beginPath(); c.arc((pol.heli.pos.x + half) * k, (pol.heli.pos.z + half) * k, 3, 0, 6.3); c.stroke(); }
    }
    c.restore();
    // Spielerpfeil (zeigt immer nach oben)
    c.fillStyle = '#36e0ff'; c.strokeStyle = '#031018'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(R, R - 9); c.lineTo(R + 6, R + 7); c.lineTo(R, R + 3); c.lineTo(R - 6, R + 7); c.closePath(); c.fill(); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 2; c.beginPath(); c.arc(R, R, R - 2, 0, Math.PI * 2); c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.8)'; c.font = 'bold 11px sans-serif'; c.textAlign = 'center';
    c.save(); c.translate(R, R); c.rotate(vehicle.yaw()); c.fillText('N', 0, -R + 14); c.restore();
  }
}

/**
 * Glättet Normalen einer nicht-indizierten Geometrie, behält aber harte Kanten
 * über dem Knickwinkel (wie BufferGeometryUtils.toCreasedNormals, ohne Addon).
 */
function smoothNormals(g, creaseDeg = 40) {
  const pos = g.attributes.position, n = pos.count;
  const cos = Math.cos(creaseDeg * Math.PI / 180);
  const faceN = new Float32Array(n * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    c.sub(b); b.sub(a); c.cross(b).normalize().negate();
    for (let k = 0; k < 3; k++) faceN.set([c.x, c.y, c.z], (i + k) * 3);
  }
  const key = (i) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const groups = new Map();
  for (let i = 0; i < n; i++) { const k = key(i); let arr = groups.get(k); if (!arr) groups.set(k, arr = []); arr.push(i); }
  const out = new Float32Array(n * 3);
  for (const arr of groups.values()) {
    for (const i of arr) {
      let x = 0, y = 0, z = 0;
      const fx = faceN[i * 3], fy = faceN[i * 3 + 1], fz = faceN[i * 3 + 2];
      for (const j of arr) {
        const gx = faceN[j * 3], gy = faceN[j * 3 + 1], gz = faceN[j * 3 + 2];
        if (fx * gx + fy * gy + fz * gz >= cos) { x += gx; y += gy; z += gz; }
      }
      const l = Math.hypot(x, y, z) || 1;
      out[i * 3] = x / l; out[i * 3 + 1] = y / l; out[i * 3 + 2] = z / l;
    }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
}

/** Keil: Grundfläche width×len, steigt in −Z-Richtung auf height. */
function makeWedge(w, h, l) {
  const hw = w / 2, hl = l / 2;
  // Ecken: Start (z=+hl, Höhe 0), Ende (z=−hl, Höhe h)
  const v = [
    [-hw, 0, hl], [hw, 0, hl], [hw, 0, -hl], [-hw, 0, -hl],   // Boden 0..3
    [-hw, h, -hl], [hw, h, -hl],                              // Oberkante 4,5
  ];
  const faces = [
    [0, 1, 5], [0, 5, 4],     // Rampenfläche
    [3, 4, 5], [3, 5, 2],     // Rückwand
    [0, 4, 3], [1, 2, 5],     // Seiten
    [0, 3, 2], [0, 2, 1],     // Boden
  ];
  const pos = [];
  for (const f of faces) for (const i of f) pos.push(...v[i]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // einfache planare UVs
  const uv = []; for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] * 0.25, pos[i + 2] * 0.25);
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Erzeugt eine kachelbare Rauschtextur (keine externen Dateien). */
function makeNoiseTexture(size, rgb, spread) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = (Math.random() - 0.5) * spread;
    img.data[i * 4] = clamp(rgb[0] + n, 0, 255);
    img.data[i * 4 + 1] = clamp(rgb[1] + n, 0, 255);
    img.data[i * 4 + 2] = clamp(rgb[2] + n, 0, 255);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export { Environment, Minimap, smoothNormals, makeWedge, makeNoiseTexture };
