import * as THREE from 'three';
import { clamp, lerp } from '../config.js';
import { mulberry32 } from './noise.js';
import { WORLD, mergeParts } from './world.js';

// ============================== Straßenleben (Stadt) ==============================
/**
 * Details, die eine Stadt glaubwürdig machen:
 *  - Bordsteine aus Granit an jedem Block
 *  - Kanaldeckel auf der Fahrbahn und Straßeneinläufe (Gullys) am Rinnstein
 *  - Stadtmöbel am Gehweg: Mülleimer, Parkscheinautomaten, Poller, Bänke –
 *    werden beim Anfahren weggeschleudert und stehen später wieder an ihrem Platz
 *  - Fußgänger, die um die Blöcke laufen und dem Auto ausweichen
 * Alles instanziert (wenige Draw-Calls), Anzahl je nach Grafikstufe.
 */
class StreetLife {
  constructor(world, scene, q) {
    this.w = world; this.scene = scene;
    const C = WORLD.city, rng = mulberry32(5150);
    this.C = C;
    const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const blocks = world.blocks;
    this._m = m4; this._q = q4; this._s = s3; this._p = p3; this._up = up; this._e = new THREE.Euler(0, 0, 0, 'YXZ'); this._q2 = new THREE.Quaternion();

    // ---------- Bordsteine ----------
    const kerbMat = new THREE.MeshStandardMaterial({ color: 0xb4b2ac, roughness: 0.85 });
    // gerade Stücke (um den Eckradius gekürzt) + je Ecke ein Bogen aus kurzen gedrehten Steinen
    const R = world.cornerR || 0, NA = R > 0 ? 6 : 0, per = 4 + 4 * NA;
    const kerb = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), kerbMat, blocks.length * per);
    blocks.forEach((b, i) => {
      const x0 = b.x0 - 4, x1 = b.x1 + 4, z0 = b.z0 - 4, z1 = b.z1 + 4, y = C.h + 0.085, t = 0.28;
      let k = i * per;
      const put = (cx, cz, sx, sz, yaw = 0) => { q4.setFromAxisAngle(up, yaw); m4.compose(p3.set(cx, y, cz), q4, s3.set(sx, 0.17, sz)); kerb.setMatrixAt(k++, m4); };
      put((x0 + x1) / 2, z0 + t / 2, x1 - x0 - 2 * R, t); put((x0 + x1) / 2, z1 - t / 2, x1 - x0 - 2 * R, t);
      put(x0 + t / 2, (z0 + z1) / 2, t, z1 - z0 - 2 * R); put(x1 - t / 2, (z0 + z1) / 2, t, z1 - z0 - 2 * R);
      const rr = R - t / 2, seg = 2 * rr * Math.sin(Math.PI / 4 / NA) + 0.04;
      for (const [cx, cz, a0] of [[x1 - R, z0 + R, -Math.PI / 2], [x1 - R, z1 - R, 0], [x0 + R, z1 - R, Math.PI / 2], [x0 + R, z0 + R, Math.PI]]) {
        for (let j = 0; j < NA; j++) {
          const a = a0 + (j + 0.5) / NA * Math.PI / 2;
          put(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, t, seg, -a);
        }
      }
    });
    kerb.receiveShadow = true; scene.add(kerb);

    // ---------- Kanaldeckel + Gullys ----------
    const coverTex = (() => {
      const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S; const c = cv.getContext('2d');
      c.fillStyle = '#2a2a2b'; c.beginPath(); c.arc(64, 64, 63, 0, 6.3); c.fill();
      c.strokeStyle = '#3d3d3e'; c.lineWidth = 3; for (let r = 14; r < 60; r += 9) { c.beginPath(); c.arc(64, 64, r, 0, 6.3); c.stroke(); }
      c.strokeStyle = '#1a1a1a'; c.lineWidth = 2; for (let a = 0; a < 6.28; a += 0.52) { c.beginPath(); c.moveTo(64, 64); c.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60); c.stroke(); }
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const grateTex = (() => {
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128; const c = cv.getContext('2d');
      c.fillStyle = '#1e1e1f'; c.fillRect(0, 0, 64, 128); c.fillStyle = '#050505';
      for (let y = 10; y < 120; y += 12) c.fillRect(8, y, 48, 6);
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const covers = [], grates = [];
    for (const e of world.edges) {
      if (e.cls !== 'city' && e.cls !== 'avenue') continue;
      const hw = e.C.halfW;
      for (let s = 20 + rng() * 20; s < e.len - 15; s += 35 + rng() * 25) {
        const p = world.pointOnEdge(e, s), side = rng() < 0.5 ? -1 : 1;
        covers.push([p.x - p.tz * side * (hw - 4.6), p.z + p.tx * side * (hw - 4.6)]);
      }
      for (const s of [20, 44, 68]) {
        const p = world.pointOnEdge(e, s);
        for (const side of [-1, 1]) grates.push([p.x - p.tz * side * (hw - 0.4), p.z + p.tx * side * (hw - 0.4), Math.atan2(p.tx, p.tz)]);
      }
    }
    const decal = (geo, tex, list, rot) => {
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.4, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((c, i) => { q4.setFromAxisAngle(up, rot ? c[2] : 0); m4.compose(p3.set(c[0], C.h + 0.075, c[1]), q4, s3.set(1, 1, 1)); im.setMatrixAt(i, m4); });
      im.receiveShadow = true; scene.add(im); return im;
    };
    decal(new THREE.CircleGeometry(0.32, 20).rotateX(-Math.PI / 2), coverTex, covers, false);
    decal(new THREE.PlaneGeometry(0.4, 0.8).rotateX(-Math.PI / 2), grateTex, grates, true);

    // ---------- Stadtmöbel (wegschleuderbar) ----------
    const dark = [0.12, 0.13, 0.14], green = [0.15, 0.32, 0.2], steel = [0.55, 0.57, 0.6], wood = [0.45, 0.3, 0.18], red = [0.6, 0.1, 0.08];
    const types = {
      bin: { parts: [{ geo: new THREE.CylinderGeometry(0.27, 0.24, 0.85, 14).translate(0, 0.425, 0), color: green }, { geo: new THREE.CylinderGeometry(0.29, 0.29, 0.05, 14).translate(0, 0.86, 0), color: dark }], r: 0.35, h: 0.9, mass: 25 },
      meter: { parts: [{ geo: new THREE.CylinderGeometry(0.04, 0.05, 1.1, 8).translate(0, 0.55, 0), color: dark }, { geo: new THREE.BoxGeometry(0.28, 0.42, 0.2).translate(0, 1.25, 0), color: steel }, { geo: new THREE.BoxGeometry(0.2, 0.1, 0.01).translate(0, 1.33, -0.105), color: [0.3, 0.6, 0.8] }], r: 0.3, h: 1.5, mass: 30 },
      bollard: { parts: [{ geo: new THREE.CylinderGeometry(0.08, 0.09, 0.95, 10).translate(0, 0.475, 0), color: dark }, { geo: new THREE.CylinderGeometry(0.085, 0.085, 0.08, 10).translate(0, 0.8, 0), color: [0.9, 0.9, 0.9] }], r: 0.2, h: 1, mass: 12 },
      bench: { parts: [{ geo: new THREE.BoxGeometry(1.7, 0.06, 0.45).translate(0, 0.45, 0), color: wood }, { geo: new THREE.BoxGeometry(1.7, 0.35, 0.05).translate(0, 0.72, 0.2), color: wood },
        { geo: new THREE.BoxGeometry(0.06, 0.45, 0.45).translate(-0.75, 0.225, 0), color: dark }, { geo: new THREE.BoxGeometry(0.06, 0.45, 0.45).translate(0.75, 0.225, 0), color: dark }], r: 0.9, h: 0.9, mass: 45 },
      hydrant: { parts: [{ geo: new THREE.CylinderGeometry(0.13, 0.15, 0.7, 12).translate(0, 0.35, 0), color: red }, { geo: new THREE.SphereGeometry(0.13, 12, 8).translate(0, 0.7, 0), color: red }, { geo: new THREE.CylinderGeometry(0.05, 0.05, 0.36, 8).rotateZ(Math.PI / 2).translate(0, 0.45, 0), color: red }], r: 0.25, h: 0.85, mass: 60 },
    };
    const order = ['bin', 'meter', 'bollard', 'bench', 'meter', 'hydrant', 'bin', 'bollard'];
    this.props = [];
    const pmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 });
    // Positionen: zwischen den Laternen, 0,7 m hinter dem Bordstein (Möbel) bzw. an der Hauswand (Bänke)
    let k = 0;
    for (const e of world.edges) {
      if (e.cls !== 'city' && e.cls !== 'avenue') continue;
      const hw = e.C.halfW;
      for (const s of [17, 36, 59, 82]) {
        if (s > e.len - 14) continue;
        const p = world.pointOnEdge(e, s);
        for (const side of [-1, 1]) {
          if (rng() < 0.25) continue;
          const t = order[k++ % order.length], T = types[t];
          const off = t === 'bench' ? hw + 3.2 : hw + 0.75;
          const ox = -p.tz * side, oz = p.tx * side;
          this.props.push({ t, x: p.x + ox * off, z: p.z + oz * off, yaw: Math.atan2(ox, oz), y: C.h + 0.12, r: T.r, h: T.h, mass: T.mass });
        }
      }
    }
    this.propMesh = {};
    for (const [t, T] of Object.entries(types)) {
      const list = this.props.filter((p) => p.t === t);
      const im = new THREE.InstancedMesh(mergeParts(T.parts), pmat, Math.max(1, list.length));
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.castShadow = false; im.receiveShadow = true;
      list.forEach((p, i) => { p.slot = i; p.mesh = im; p.home = { x: p.x, z: p.z, yaw: p.yaw }; p.q = new THREE.Quaternion().setFromAxisAngle(up, p.yaw); p.vel = new THREE.Vector3(); p.av = new THREE.Vector3(); p.fly = false; p.t0 = 0; this.writeProp(p); });
      im.count = list.length; scene.add(im); this.propMesh[t] = im;
    }
    this.propHash = new Map();
    for (const p of this.props) { const key = this.key(p.x, p.z); if (!this.propHash.has(key)) this.propHash.set(key, []); this.propHash.get(key).push(p); }

    // ---------- Fußgänger ----------
    const N = q.pedestrians || 0;
    this.peds = [];
    if (N > 0) {
      const skin = [[0.95, 0.8, 0.68], [0.82, 0.62, 0.48], [0.6, 0.42, 0.3], [0.4, 0.28, 0.2]];
      const cloth = [[0.15, 0.18, 0.25], [0.6, 0.6, 0.62], [0.55, 0.12, 0.12], [0.2, 0.35, 0.55], [0.85, 0.82, 0.75], [0.12, 0.12, 0.12], [0.35, 0.45, 0.3], [0.75, 0.55, 0.3]];
      const pants = [[0.12, 0.14, 0.2], [0.2, 0.2, 0.22], [0.35, 0.3, 0.25], [0.1, 0.1, 0.1]];
      const bodyGeo = mergeParts([
        { geo: new THREE.CapsuleGeometry(0.19, 0.42, 4, 10).scale(1, 1, 0.65).translate(0, 1.18, 0), color: [1, 1, 1] },            // Oberkörper (Kleidung)
      ]);
      const headGeo = new THREE.SphereGeometry(0.115, 12, 10).translate(0, 1.67, 0);
      const legGeo = new THREE.CapsuleGeometry(0.075, 0.68, 4, 8).translate(0, -0.42, 0);   // Drehpunkt an der Hüfte
      const armGeo = new THREE.CapsuleGeometry(0.05, 0.5, 4, 8).translate(0, -0.3, 0);       // Drehpunkt an der Schulter
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
      const mk = (geo, n) => { const im = new THREE.InstancedMesh(geo, mat, n); im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.castShadow = false; im.frustumCulled = false; scene.add(im); return im; };
      this.pm = { body: mk(bodyGeo, N), head: mk(headGeo, N), leg: mk(legGeo, N * 2), arm: mk(armGeo, N * 2) };
      const col = new THREE.Color();
      const city = blocks.filter((b) => !b.park);
      for (let i = 0; i < N; i++) {
        const b = city[Math.floor(rng() * city.length)];
        // Rundweg um den Block, 1,6 m vor der Hauswand
        const x0 = b.x0 - 1.6, x1 = b.x1 + 1.6, z0 = b.z0 - 1.6, z1 = b.z1 + 1.6;
        const per = 2 * (x1 - x0) + 2 * (z1 - z0);
        const ped = { rect: [x0, x1, z0, z1], per, s: rng() * per, dir: rng() < 0.5 ? 1 : -1, speed: 1.1 + rng() * 0.6, phase: rng() * 6.28,
          dodge: 0, dodgeV: 0, x: 0, z: 0, yaw: 0, h: 0.92 + rng() * 0.16 };
        this.peds.push(ped);
        const sc = skin[Math.floor(rng() * skin.length)], cl = cloth[Math.floor(rng() * cloth.length)], pa = pants[Math.floor(rng() * pants.length)];
        this.pm.body.setColorAt(i, col.setRGB(cl[0], cl[1], cl[2], THREE.SRGBColorSpace));
        this.pm.head.setColorAt(i, col.setRGB(sc[0], sc[1], sc[2], THREE.SRGBColorSpace));
        for (const k2 of [0, 1]) { this.pm.leg.setColorAt(i * 2 + k2, col.setRGB(pa[0], pa[1], pa[2], THREE.SRGBColorSpace)); this.pm.arm.setColorAt(i * 2 + k2, col.setRGB(cl[0] * 0.9, cl[1] * 0.9, cl[2] * 0.9, THREE.SRGBColorSpace)); }
      }
    }
  }

  key(x, z) { return Math.floor(x / 20) + ',' + Math.floor(z / 20); }

  writeProp(p) {
    this._m.compose(this._p.set(p.x, p.y, p.z), p.q, this._s.set(1, 1, 1));
    p.mesh.setMatrixAt(p.slot, this._m);
    p.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Position auf dem Rundweg (Rechteck) → Punkt + Blickrichtung. */
  walkPos(ped) {
    const [x0, x1, z0, z1] = ped.rect, wx = x1 - x0, wz = z1 - z0;
    let s = ((ped.s % ped.per) + ped.per) % ped.per, x, z, dx, dz;
    if (s < wx) { x = x0 + s; z = z0; dx = 1; dz = 0; }
    else if ((s -= wx) < wz) { x = x1; z = z0 + s; dx = 0; dz = 1; }
    else if ((s -= wz) < wx) { x = x1 - s; z = z1; dx = -1; dz = 0; }
    else { s -= wx; x = x0; z = z1 - s; dx = 0; dz = -1; }
    // Ausweichen: nach außen = weg von der Hauswand? → nach innen zur Hauswand (sicher)
    const nx = -dz, nz = dx;     // zeigt nach innen zur Hauswand
    return [x + nx * ped.dodge, z + nz * ped.dodge, dx * ped.dir, dz * ped.dir];
  }

  update(dt, v, cam) {
    if (!dt) return;
    const C = this.C, px = v.pos.x, pz = v.pos.z, py = v.pos.y;
    const inCity = px > C.x0 - 60 && px < C.x1 + 60 && pz > C.z0 - 60 && pz < C.z1 + 60;
    // ---------- Stadtmöbel: Treffer + Flug ----------
    if (inCity && v.speed > 1.5 && py < C.h + 3) {
      const cand = this.propHash.get(this.key(px, pz)) || [];
      const near = [cand];
      for (const dx of [-20, 0, 20]) for (const dz of [-20, 0, 20]) if (dx || dz) { const l = this.propHash.get(this.key(px + dx, pz + dz)); if (l) near.push(l); }
      for (const list of near) for (const p of list) {
        if (p.fly) continue;
        const ddx = p.x - px, ddz = p.z - pz, d = Math.hypot(ddx, ddz);
        if (d > p.r + 1.3) continue;
        // Wegschleudern: Richtung = Fahrtrichtung + etwas vom Kontaktpunkt weg, Auto bremst etwas ab
        const sp = v.speed, k = clamp(sp * 0.9, 2, 30);
        p.vel.set(v.vel.x * 0.85 + ddx / (d || 1) * 2, 2 + sp * 0.18, v.vel.z * 0.85 + ddz / (d || 1) * 2);
        p.av.set((Math.random() - 0.5) * k * 0.6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * k * 0.6);
        p.fly = true; p.t0 = 0;
        const loss = Math.min(0.12, p.mass / 1700);
        v.vel.multiplyScalar(1 - loss);
        v.lastImpact = Math.max(v.lastImpact || 0, Math.min(4, sp * 0.15));
      }
    }
    for (const p of this.props) {
      if (!p.fly) continue;
      p.t0 += dt;
      p.vel.y -= 9.81 * dt;
      p.x += p.vel.x * dt; p.y += p.vel.y * dt; p.z += p.vel.z * dt;
      const g = this.w.sample(p.x, p.z);
      if (p.y < g + 0.02) {               // Aufprall auf dem Boden: springen, rutschen, liegen bleiben
        p.y = g + 0.02; p.vel.y *= -0.25; p.vel.x *= 0.7; p.vel.z *= 0.7; p.av.multiplyScalar(0.6);
        if (Math.abs(p.vel.y) < 0.5) p.vel.y = 0;
      }
      if (p.av.lengthSq() > 1e-4) { this._e.set(p.av.x * dt, p.av.y * dt, p.av.z * dt); this._q2.setFromEuler(this._e); p.q.premultiply(this._q2); }
      // nach 25 s außer Sicht wieder an den alten Platz
      const far = Math.hypot(p.home.x - px, p.home.z - pz) > 70;
      if (p.t0 > 25 && far) { p.fly = false; p.x = p.home.x; p.z = p.home.z; p.y = C.h + 0.12; p.q.setFromAxisAngle(this._up, p.home.yaw); }
      this.writeProp(p);
    }

    // ---------- Fußgänger ----------
    if (!this.peds.length) return;
    const pm = this.pm, m = this._m, q = this._q, s = this._s, pos = this._p, e = this._e;
    const vis = !this.hidePeds && (inCity || Math.hypot(cam.x - C.cx, cam.z - C.cz) < 600);
    for (const k of ['body', 'head', 'leg', 'arm']) pm[k].visible = vis;
    if (!vis) return;
    let i = 0;
    for (const ped of this.peds) {
      const [wx, wz] = this.walkPos(ped);
      // Auto in der Nähe und schnell → seitlich zur Hauswand ausweichen (springen)
      const dpx = px - wx, dpz = pz - wz, d2 = dpx * dpx + dpz * dpz;
      const danger = d2 < 64 && v.speed > 2.5 && py < C.h + 3;
      const target = danger ? 1.4 : 0;
      ped.dodgeV = danger ? 6 : 1.2;
      ped.dodge += clamp(target - ped.dodge, -ped.dodgeV * dt, ped.dodgeV * dt);
      const stop = danger ? 0 : 1;
      ped.s += ped.dir * ped.speed * dt * stop;
      ped.phase += dt * ped.speed * 5.2 * stop;
      const [x, z, dx, dz] = this.walkPos(ped);
      // LOD: Fußgänger weiter als 140 m werden nicht gezeichnet (Skalierung 0), gehen aber weiter
      if ((x - cam.x) ** 2 + (z - cam.z) ** 2 > 140 * 140) {
        m.makeScale(0, 0, 0); pm.body.setMatrixAt(i, m); pm.head.setMatrixAt(i, m);
        for (const k2 of [0, 1]) { pm.leg.setMatrixAt(i * 2 + k2, m); pm.arm.setMatrixAt(i * 2 + k2, m); }
        i++; continue;
      }
      const yaw = Math.atan2(-dx, -dz), sw = Math.sin(ped.phase) * 0.42 * stop, bob = Math.abs(Math.cos(ped.phase)) * 0.03 * stop;
      const y = C.h + 0.12;
      q.setFromAxisAngle(this._up, yaw);
      m.compose(pos.set(x, y + bob, z), q, s.set(ped.h, ped.h, ped.h)); pm.body.setMatrixAt(i, m); pm.head.setMatrixAt(i, m);
      for (const side of [-1, 1]) {
        // Beine (Hüfte 0,9 m) und Arme (Schulter 1,42 m) schwingen gegenläufig
        e.set(sw * side, yaw, 0, 'YXZ'); q.setFromEuler(e);
        const ox = Math.cos(yaw) * side * 0.1 * ped.h, oz = -Math.sin(yaw) * side * 0.1 * ped.h;
        m.compose(pos.set(x + ox, y + 0.9 * ped.h + bob, z + oz), q, s.set(ped.h, ped.h, ped.h)); pm.leg.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), m);
        e.set(-sw * side * 0.8, yaw, side * 0.08, 'YXZ'); q.setFromEuler(e);
        const ax = Math.cos(yaw) * side * 0.24 * ped.h, az = -Math.sin(yaw) * side * 0.24 * ped.h;
        m.compose(pos.set(x + ax, y + 1.42 * ped.h + bob, z + az), q, s.set(ped.h, ped.h, ped.h)); pm.arm.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), m);
      }
      i++;
    }
    for (const k of ['body', 'head', 'leg', 'arm']) pm[k].instanceMatrix.needsUpdate = true;
  }
}

export { StreetLife };
