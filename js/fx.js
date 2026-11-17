import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './config.js';
import { mulberry32, hash2 } from './world/noise.js';

// ============================== Partikel ==============================
/**
 * Funken, Reifenqualm, Staub, Blätter, Holzsplitter, Wasser, Plasma.
 * Zwei Punktwolken (additiv für Leuchtendes, normal für Rauch/Staub),
 * jeweils ein Draw-Call; die Bewegung rechnet die CPU.
 */
const PARTICLE_KINDS = {
  spark:  { add: true,  life: 0.5, size: [0.22, 0.05], col: [[1.6, 0.9, 0.35], [1.2, 0.3, 0.05]], alpha: [1, 0.6], g: 9.8, drag: 0.6 },
  plasma: { add: true,  life: 0.32, size: [0.7, 0.1], col: [[0.6, 1.3, 1.8], [0.2, 0.4, 1.6]], alpha: [0.9, 0], g: 0, drag: 3 },
  smoke:  { add: false, life: 2.2, size: [1.2, 5.0], col: [[0.86, 0.86, 0.88], [0.7, 0.7, 0.72]], alpha: [0.32, 0], g: -0.7, drag: 1.6 },
  dust:   { add: false, life: 1.7, size: [1.0, 4.2], col: [[0.6, 0.53, 0.4], [0.62, 0.56, 0.45]], alpha: [0.42, 0], g: -0.2, drag: 1.8 },
  leaf:   { add: false, life: 3.2, size: [0.28, 0.24], col: [[0.25, 0.45, 0.12], [0.35, 0.42, 0.12]], alpha: [1, 0.9], g: 1.3, drag: 2.6, flutter: true },
  chip:   { add: false, life: 1.4, size: [0.2, 0.18], col: [[0.55, 0.4, 0.25], [0.5, 0.36, 0.22]], alpha: [1, 1], g: 9.8, drag: 0.4 },
  splash: { add: false, life: 1.0, size: [0.5, 1.8], col: [[0.85, 0.92, 0.98], [0.75, 0.85, 0.95]], alpha: [0.7, 0], g: 9.8, drag: 0.8 },
};

class Particles {
  constructor(scene, cap) {
    this.sys = [true, false].map((add) => this.makeSystem(scene, cap, add));
    this.rng = Math.random;
  }
  makeSystem(scene, cap, add) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(cap * 3), col = new Float32Array(cap * 3), alpha = new Float32Array(cap), size = new Float32Array(cap);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 400 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; uniform float uScale; varying vec4 vC;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(size * uScale / -mv.z, 1.0, 256.0);
          gl_Position = projectionMatrix * mv; vC = vec4(color, alpha); }`,
      fragmentShader: `varying vec4 vC; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(vC.rgb, vC.a * a);
          #include <colorspace_fragment>
        }`,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false; pts.renderOrder = 5;
    scene.add(pts);
    return { pts, g, mat, cap, n: 0, P: [] };
  }
  setScale(px) { for (const s of this.sys) s.mat.uniforms.uScale.value = px; }

  emit(kind, x, y, z, vx, vy, vz, count = 1, spread = 1) {
    const K = PARTICLE_KINDS[kind], s = this.sys[K.add ? 0 : 1];
    for (let i = 0; i < count; i++) {
      if (s.P.length >= s.cap) s.P.shift();
      const r = this.rng;
      s.P.push({ K, x: x + (r() - 0.5) * 0.3 * spread, y: y + (r() - 0.5) * 0.2 * spread, z: z + (r() - 0.5) * 0.3 * spread,
        vx: vx + (r() - 0.5) * 2 * spread, vy: vy + (r() - 0.5) * 2 * spread, vz: vz + (r() - 0.5) * 2 * spread,
        age: 0, life: K.life * (0.7 + r() * 0.6), ph: r() * 6.28, sz: 0.8 + r() * 0.4 });
    }
  }

  update(dt) {
    for (const s of this.sys) {
      const pa = s.g.attributes.position.array, ca = s.g.attributes.color.array, aa = s.g.attributes.alpha.array, sa = s.g.attributes.size.array;
      let n = 0;
      const keep = [];
      for (const p of s.P) {
        p.age += dt;
        if (p.age >= p.life) continue;
        const K = p.K, t = p.age / p.life;
        const dk = Math.exp(-K.drag * dt);
        p.vx *= dk; p.vz *= dk; p.vy = p.vy * dk - K.g * dt;
        if (K.flutter) { p.vx += Math.sin(p.age * 6 + p.ph) * 3 * dt; p.vz += Math.cos(p.age * 5 + p.ph) * 3 * dt; }
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        pa[n * 3] = p.x; pa[n * 3 + 1] = p.y; pa[n * 3 + 2] = p.z;
        ca[n * 3] = lerp(K.col[0][0], K.col[1][0], t); ca[n * 3 + 1] = lerp(K.col[0][1], K.col[1][1], t); ca[n * 3 + 2] = lerp(K.col[0][2], K.col[1][2], t);
        aa[n] = lerp(K.alpha[0], K.alpha[1], t) * Math.min(1, p.age * 12);
        sa[n] = lerp(K.size[0], K.size[1], Math.sqrt(t)) * p.sz;
        keep.push(p); n++;
      }
      s.P = keep;
      s.g.setDrawRange(0, n);
      for (const k of ['position', 'color', 'alpha', 'size']) s.g.attributes[k].needsUpdate = true;
    }
  }
}

// ============================== Gras ==============================
/** Grasbüschel rund um die Kamera (wiegen im Wind), nur auf Wiesen. */
class Grass {
  constructor(world, scene, q) {
    this.w = world; this.cap = q.grass; this.R = q.grassRadius; this.cell = 1.35;
    this.last = new THREE.Vector3(1e9, 0, 0);
    if (!this.cap) return;
    // Textur: viele schmale Halme mit Transparenz
    const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const c = cv.getContext('2d'), rng = mulberry32(12);
    for (let i = 0; i < 140; i++) {
      const x = 8 + rng() * (S - 16), h = S * (0.45 + rng() * 0.55), bend = (rng() - 0.5) * 40, w = 2 + rng() * 3;
      const l = 17 + rng() * 17;
      c.fillStyle = `hsl(${70 + rng() * 26},${24 + rng() * 20}%,${l}%)`;
      c.beginPath(); c.moveTo(x - w, S); c.quadraticCurveTo(x + bend * 0.3, S - h * 0.6, x + bend, S - h); c.quadraticCurveTo(x + bend * 0.3 + w * 0.3, S - h * 0.6, x + w, S); c.fill();
    }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const parts = [];
    for (let k = 0; k < 3; k++) {
      const p = new THREE.PlaneGeometry(0.9, 0.5); p.translate(0, 0.25, 0); p.rotateY(k * Math.PI / 3);
      // Normalen nach oben kippen → wirkt wie Wiese, nicht wie Karten
      const n = p.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, n.getX(i) * 0.3, 0.95, n.getZ(i) * 0.3);
      parts.push(p);
    }
    const geo = new THREE.BufferGeometry();
    const merged = parts.map((p) => p.toNonIndexed());
    const cnt = merged.reduce((a, g) => a + g.attributes.position.count, 0);
    for (const k of ['position', 'normal', 'uv']) {
      const sz = k === 'uv' ? 2 : 3, arr = new Float32Array(cnt * sz); let o = 0;
      for (const g of merged) { arr.set(g.attributes[k].array, o); o += g.attributes[k].array.length; }
      geo.setAttribute(k, new THREE.BufferAttribute(arr, sz));
    }
    this.time = { value: 0 };
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 });
    const time = this.time;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = time;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 ip = instanceMatrix[3].xyz;
        float sway = sin(uTime * 1.8 + ip.x * 0.35 + ip.z * 0.27) + 0.5 * sin(uTime * 3.1 + ip.x * 0.9);
        transformed.x += sway * 0.07 * position.y; transformed.z += sway * 0.05 * position.y;`);
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, this.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.receiveShadow = true;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  update(dt, cam) {
    if (!this.cap) return;
    this.time.value += dt;
    if (cam.distanceToSquared(this.last) < 36) return;
    this.last.copy(cam);
    const w = this.w, C = this.cell, R = this.R, cnt = this.cap;
    let k = 0;
    const i0 = Math.floor((cam.x - R) / C), i1 = Math.floor((cam.x + R) / C), j0 = Math.floor((cam.z - R) / C), j1 = Math.floor((cam.z + R) / C);
    for (let j = j0; j <= j1 && k < cnt; j++) {
      for (let i = i0; i <= i1 && k < cnt; i++) {
        const h1 = hash2(i, j, 91) * 0.5 + 0.5, h2 = hash2(i, j, 92) * 0.5 + 0.5, h3 = hash2(i, j, 93) * 0.5 + 0.5;
        const x = (i + h1) * C, z = (j + h2) * C;
        const d = Math.hypot(x - cam.x, z - cam.z);
        if (d > R) continue;
        const su = w.surfaceAt(x, z);
        if (su !== 0 && !(su === 2 && h3 > 0.5)) continue;
        const gi = Math.round((x + w.half) / w.cell), gj = Math.round((z + w.half) / w.cell);
        if (w.roadW[gj * w.n + gi] > 0.15) continue;
        const y = w.sample(x, z);
        if (y < w.waterLevel + 0.6) continue;
        const sc = (0.75 + h3 * 0.7) * (1 - smoothstep(R * 0.7, R, d));
        this._q.setFromAxisAngle(this._up, h1 * 6.28);
        this._m.compose(this._p.set(x, y - 0.05, z), this._q, this._s.set(sc, sc * (0.8 + h2 * 0.5), sc));
        this.mesh.setMatrixAt(k, this._m);
        this.mesh.setColorAt(k, this._c.setRGB(0.78 + h2 * 0.22, 0.82 + h1 * 0.14, 0.62 + h3 * 0.16));
        k++;
      }
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true;
  }
}

// ============================== Starrkörper (Verkehr nach Zusammenstoß) ==============================
/** Quader mit 6 Freiheitsgraden: kann rutschen, kippen und sich überschlagen. */
class RigidBox {
  constructor(mass, hx, hy, hz) {
    this.m = mass; this.invM = 1 / mass;
    this.inv = new THREE.Vector3(3 / (mass * (hy * hy + hz * hz)), 3 / (mass * (hx * hx + hz * hz)), 3 / (mass * (hx * hx + hy * hy)));
    this.pos = new THREE.Vector3(); this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3(); this.angVel = new THREE.Vector3();
    this.h = [hx, hy, hz];
    this.corners = [];
    for (const x of [-hx, hx]) for (const y of [-hy, hy]) for (const z of [-hz, hz]) this.corners.push(new THREE.Vector3(x, y, z));
    this.sleep = 0;
    this._t = Array.from({ length: 8 }, () => new THREE.Vector3()); this._qi = new THREE.Quaternion(); this._dq = new THREE.Quaternion();
  }
  invI(v) { this._qi.copy(this.quat).invert(); v.applyQuaternion(this._qi); v.x *= this.inv.x; v.y *= this.inv.y; v.z *= this.inv.z; return v.applyQuaternion(this.quat); }
  pointVel(p, out) { return out.subVectors(p, this.pos).crossVectors(this.angVel, out).add(this.vel); }
  effInv(r, n) { const t = this._t[7].crossVectors(r, n); return this.invM + this.invI(t).cross(r).dot(n); }
  impulse(J, p) {
    this.vel.addScaledVector(J, this.invM);
    const r = this._t[6].subVectors(p, this.pos);
    this.angVel.add(this.invI(r.cross(J)));
    this.sleep = 0;
  }
  step(dt, world) {
    if (this.sleep > 1.2) return;
    this.vel.y -= 9.81 * dt;
    this.angVel.multiplyScalar(Math.exp(-0.15 * dt));
    this.pos.addScaledVector(this.vel, dt);
    const a = this.angVel;
    this._dq.set(a.x * dt * 0.5, a.y * dt * 0.5, a.z * dt * 0.5, 0).multiply(this.quat);
    this.quat.x += this._dq.x; this.quat.y += this._dq.y; this.quat.z += this._dq.z; this.quat.w += this._dq.w; this.quat.normalize();
    // Bodenkontakt an den Ecken
    const n = this._t[0], p = this._t[1], r = this._t[2], pv = this._t[3], J = this._t[4], vt = this._t[5];
    for (const c of this.corners) {
      p.copy(c).applyQuaternion(this.quat).add(this.pos);
      const h = world.sample(p.x, p.z, n, p.y);
      const depth = h - p.y;
      if (depth <= 0) continue;
      this.pos.addScaledVector(n, depth * 0.5);
      r.subVectors(p, this.pos);
      pv.crossVectors(this.angVel, r).add(this.vel);
      const vn = pv.dot(n);
      if (vn >= 0) continue;
      const k = this.effInv(r, n);
      const jn = -(1 + 0.2) * vn / k;
      J.copy(n).multiplyScalar(jn);
      vt.copy(pv).addScaledVector(n, -vn);
      const vl = vt.length();
      if (vl > 1e-3) J.addScaledVector(vt, -Math.min(vl / k, 0.65 * jn) / vl);
      this.impulse(J, p);
    }
    // Hauswände: Mittelpunkt aus Gebäuden herausschieben
    const bs = world.buildingHash.at(this.pos.x, this.pos.z);
    for (const b of bs) {
      const x = this.pos.x, z = this.pos.z;
      if (x <= b.x0 - 1 || x >= b.x1 + 1 || z <= b.z0 - 1 || z >= b.z1 + 1 || this.pos.y > b.top) continue;
      const dl = x - (b.x0 - 1), dr = b.x1 + 1 - x, dn = z - (b.z0 - 1), ds = b.z1 + 1 - z, m = Math.min(dl, dr, dn, ds);
      if (m === dl) { this.pos.x -= dl; this.vel.x = -Math.abs(this.vel.x) * 0.3; } else if (m === dr) { this.pos.x += dr; this.vel.x = Math.abs(this.vel.x) * 0.3; }
      else if (m === dn) { this.pos.z -= dn; this.vel.z = -Math.abs(this.vel.z) * 0.3; } else { this.pos.z += ds; this.vel.z = Math.abs(this.vel.z) * 0.3; }
    }
    if (this.vel.lengthSq() < 0.04 && this.angVel.lengthSq() < 0.04) this.sleep += dt; else this.sleep = 0;
  }
}

export { PARTICLE_KINDS, Particles, Grass, RigidBox };
