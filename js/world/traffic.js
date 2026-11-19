import * as THREE from 'three';
import { clamp } from '../config.js';
import { mulberry32 } from './noise.js';
import { ROAD_CLASS, mergeParts, makeBlobTexture, radialTexture } from './world.js';
import { RigidBox } from '../fx.js';

// ============================== Verkehr ==============================
const TRAFFIC_TYPES = {
  sedan: { L: 4.7, W: 1.84, H: 1.45, hood: 1.15, trunk: 0.85, wr: 0.33, mass: 1450, weight: 0.38 },
  hatch: { L: 4.15, W: 1.78, H: 1.5, hood: 0.95, trunk: 0.2, wr: 0.32, mass: 1250, weight: 0.3 },
  suv:   { L: 4.8, W: 1.95, H: 1.78, hood: 1.05, trunk: 0.3, wr: 0.38, mass: 2050, weight: 0.22 },
  truck: { L: 8.4, W: 2.5, H: 3.4, wr: 0.5, mass: 9000, weight: 0.1 },
};
const CAR_PAINTS = [[0.92, 0.92, 0.92], [0.66, 0.68, 0.7], [0.1, 0.1, 0.11], [0.3, 0.32, 0.34], [0.12, 0.2, 0.36],
  [0.55, 0.08, 0.09], [0.7, 0.6, 0.45], [0.16, 0.3, 0.2], [0.85, 0.85, 0.82], [0.2, 0.22, 0.25]];

/** Modell eines Verkehrsautos als eine Geometrie (Karosserie weiß → per Instanzfarbe lackiert). */
function makeTrafficVariant(type) {
  const s = TRAFFIC_TYPES[type], L = s.L, W = s.W, Hh = s.H;
  const BODY = [0.93, 0.93, 0.93], GLASS = [0.07, 0.08, 0.1], DARK = [0.06, 0.06, 0.07], RIM = [0.55, 0.56, 0.58];
  const parts = [], lights = [], glassParts = [];
  const extrude = (pts, width, bevel) => {
    const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    const depth = width - bevel * 2;
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 1, curveSegments: 2 });
    g.translate(0, 0, -depth / 2); g.rotateY(-Math.PI / 2); g.computeVertexNormals();
    return g;
  };
  const wheel = (x, z, r) => {
    parts.push({ geo: new THREE.CylinderGeometry(r, r, 0.26, 14).rotateZ(Math.PI / 2).translate(x, r, z), color: DARK });
    parts.push({ geo: new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.27, 10).rotateZ(Math.PI / 2).translate(x * 1.005, r, z), color: RIM });
  };
  if (type === 'truck') {
    const cabL = 2.3;
    parts.push({ geo: new THREE.BoxGeometry(W, 2.4, cabL).translate(0, 0.6 + 1.2, -L / 2 + cabL / 2), color: BODY });
    parts.push({ geo: new THREE.BoxGeometry(W - 0.1, 0.9, 0.05).translate(0, 2.35, -L / 2 - 0.01), color: GLASS });
    parts.push({ geo: new THREE.BoxGeometry(W + 0.04, 2.9, L - cabL - 0.25).translate(0, 0.75 + 1.45, L / 2 - (L - cabL - 0.25) / 2), color: [0.85, 0.86, 0.87] });
    parts.push({ geo: new THREE.BoxGeometry(W - 0.3, 0.35, L - 0.4).translate(0, 0.55, 0), color: DARK });
    for (const z of [-L / 2 + 1.3, L / 2 - 2.4, L / 2 - 1.2]) for (const x of [-1, 1]) wheel(x * (W / 2 - 0.25), z, s.wr);
    parts.push({ geo: new THREE.BoxGeometry(0.52, 0.12, 0.03).translate(0, 0.62, -L / 2 - 0.03), color: [0.9, 0.9, 0.86] });
    parts.push({ geo: new THREE.BoxGeometry(0.52, 0.12, 0.03).translate(0, 0.62, L / 2 + 0.03), color: [0.9, 0.9, 0.86] });
    parts[0].paint = true; parts[2].paint = true;
    for (const x of [-1, 1]) {
      lights.push({ geo: new THREE.BoxGeometry(0.4, 0.18, 0.04).translate(x * (W / 2 - 0.35), 0.95, -L / 2 - 0.02), color: [1, 0.96, 0.88] });
      lights.push({ geo: new THREE.BoxGeometry(0.3, 0.2, 0.04).translate(x * (W / 2 - 0.25), 0.9, L / 2 + 0.02), color: [0.9, 0.04, 0.04], mask: [1, 0, 0] });
      for (const z of [-L / 2 - 0.02, L / 2 + 0.02]) lights.push({ geo: new THREE.BoxGeometry(0.18, 0.12, 0.04).translate(x * (W / 2 - 0.08), 1.15, z), color: [1, 0.5, 0.04], mask: [0, x < 0 ? 1 : 0, x > 0 ? 1 : 0] });
    }
  } else {
    // Seitenprofil mit ausgeschnittenen Radhäusern (z vorn = −L/2)
    const zf = -L / 2 + 0.9, zr = L / 2 - 0.85, R = s.wr + 0.07, yb = 0.3;
    const arch = (zc, from, to) => { const pts = []; for (let i = 0; i <= 8; i++) { const a = from + (to - from) * i / 8; pts.push([zc + R * Math.cos(a), s.wr + R * Math.sin(a)]); } return pts; };
    const lo = [[-L / 2 + 0.08, yb], [-L / 2 - 0.02, 0.46], [-L / 2 + 0.01, 0.62], [-L / 2 + 0.14, 0.74], [-L / 2 + 0.55, 0.81], [-L / 2 + s.hood, 0.86],
      [L / 2 - s.trunk, 0.9], [L / 2 - 0.1, 0.88], [L / 2 + 0.01, 0.78], [L / 2 + 0.02, 0.5], [L / 2 - 0.06, yb],
      [zr + R, yb], ...arch(zr, 0, Math.PI), [zr - R, yb], [zf + R, yb], ...arch(zf, 0, Math.PI), [zf - R, yb]];
    const body = extrude(lo, W, 0.09);
    const gh = [[-L / 2 + s.hood, 0.84], [-L / 2 + s.hood + 0.8, Hh - 0.02], [-L / 2 + s.hood + 1.0, Hh], [L / 2 - s.trunk - 0.7, Hh], [L / 2 - s.trunk - 0.5, Hh - 0.03], [L / 2 - s.trunk, 0.88]];
    const glass = extrude(gh, W - 0.14, 0.05);
    // Dach eingezogen (Tumblehome) und Ecken in der Draufsicht gerundet
    const shape = (g) => {
      const a = g.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const y = a.getY(i), z = a.getZ(i);
        const t = clamp((y - 0.72) / (Hh - 0.72), 0, 1), e = Math.pow(Math.abs(z) / (L / 2), 4);
        a.setX(i, a.getX(i) * (1 - t * 0.16) * (1 - e * 0.08));
      }
      g.computeVertexNormals(); return g;
    };
    parts.push({ geo: shape(body), color: BODY, paint: true });
    glassParts.push({ geo: shape(glass), color: [1, 1, 1] });          // getönt-durchsichtig (eigenes Material)
    // Innenraum hinter den Scheiben: Boden auf Brüstungshöhe, Sitzlehnen, Fahrer (links), Kopfstützen
    const zs = -L / 2 + s.hood + 1.25;
    parts.push({ geo: new THREE.BoxGeometry(W - 0.3, 0.04, L - s.hood - s.trunk - 0.6).translate(0, 0.82, (-L / 2 + s.hood + L / 2 - s.trunk) / 2), color: [0.08, 0.08, 0.09] });
    for (const sx of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(0.46, 0.5, 0.1).translate(sx * 0.4, 1.0, zs + 0.28), color: [0.12, 0.12, 0.13] });
      parts.push({ geo: new THREE.BoxGeometry(0.24, 0.14, 0.09).translate(sx * 0.4, Hh - 0.16, zs + 0.3), color: [0.12, 0.12, 0.13] });
    }
    parts.push({ geo: new THREE.BoxGeometry(0.42, 0.26, 0.24).translate(-0.4, 0.96, zs + 0.08), color: [0.25, 0.28, 0.34] });   // Fahrer: Oberkörper
    parts.push({ geo: new THREE.SphereGeometry(0.1, 10, 8).translate(-0.4, Hh - 0.3, zs + 0.06), color: [0.8, 0.62, 0.5] });     // Kopf
    parts.push({ geo: new THREE.SphereGeometry(0.105, 10, 8).scale(1, 0.6, 1).translate(-0.4, Hh - 0.24, zs + 0.08), color: [0.2, 0.14, 0.1] });   // Haare
    const r0 = -L / 2 + s.hood + 1.0, r1 = L / 2 - s.trunk - 0.7;
    parts.push({ geo: shape(new THREE.BoxGeometry(W - 0.42, 0.05, r1 - r0).translate(0, Hh + 0.015, (r0 + r1) / 2)), color: BODY, paint: true });   // Dach
    parts.push({ geo: shape(new THREE.BoxGeometry(W - 0.2, 0.36, 0.09).translate(0, Hh - 0.24, (r0 + r1) / 2 + 0.1)), color: DARK });                // B-Säule
    parts.push({ geo: shape(new THREE.BoxGeometry(W + 0.005, 0.035, L * 0.5).translate(0, 0.86, -0.1)), color: DARK });                           // Fensterleiste
    // Radhausschalen (verhindern Durchblick), Stoßfänger, Grill, Kennzeichen, Spiegel
    for (const z of [zf, zr]) parts.push({ geo: new THREE.BoxGeometry(W - 0.5, R * 1.1, R * 2).translate(0, s.wr + R * 0.45, z), color: DARK });
    parts.push({ geo: new THREE.BoxGeometry(W - 0.1, 0.16, 0.1).translate(0, 0.36, -L / 2 + 0.01), color: DARK });
    parts.push({ geo: new THREE.BoxGeometry(W - 0.1, 0.16, 0.1).translate(0, 0.38, L / 2 - 0.02), color: DARK });
    parts.push({ geo: new THREE.BoxGeometry(W * 0.46, 0.15, 0.06).translate(0, 0.6, -L / 2 - 0.01), color: [0.03, 0.03, 0.035] });
    parts.push({ geo: new THREE.BoxGeometry(0.52, 0.12, 0.03).translate(0, 0.42, -L / 2 - 0.06), color: [0.9, 0.9, 0.86] });
    parts.push({ geo: new THREE.BoxGeometry(0.52, 0.12, 0.03).translate(0, 0.56, L / 2 + 0.04), color: [0.9, 0.9, 0.86] });
    for (const x of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(0.2, 0.12, 0.1).translate(x * (W / 2 + 0.02), 0.98, -L / 2 + s.hood + 0.25), color: BODY, paint: true });
      parts.push({ geo: new THREE.BoxGeometry(0.06, 0.1, 0.06).translate(x * (W / 2 - 0.12), 0.93, -L / 2 + s.hood + 0.25), color: DARK });
    }
    for (const z of [zf, zr]) for (const x of [-1, 1]) {
      const wx = x * (W / 2 - 0.16), r = s.wr;
      parts.push({ geo: new THREE.CylinderGeometry(r, r, 0.24, 18).rotateZ(Math.PI / 2).translate(wx, r, z), color: DARK });
      parts.push({ geo: new THREE.CylinderGeometry(r * 0.66, r * 0.66, 0.02, 14).rotateZ(Math.PI / 2).translate(wx + x * 0.121, r, z), color: RIM });
      parts.push({ geo: new THREE.CylinderGeometry(r * 0.5, r * 0.5, 0.02, 10).rotateZ(Math.PI / 2).translate(wx + x * 0.125, r, z), color: [0.16, 0.16, 0.17] });
      for (let k = 0; k < 5; k++) parts.push({ geo: new THREE.BoxGeometry(0.02, r * 0.95, 0.06).rotateX(k * Math.PI * 2 / 5).translate(wx + x * 0.135, r, z), color: RIM });
    }
    for (const x of [-1, 1]) {
      lights.push({ geo: new THREE.BoxGeometry(0.42, 0.09, 0.08).translate(x * (W / 2 - 0.32), 0.68, -L / 2 + 0.03), color: [1, 0.96, 0.88] });
      lights.push({ geo: new THREE.BoxGeometry(0.46, 0.1, 0.06).translate(x * (W / 2 - 0.3), 0.76, L / 2 + 0.0), color: [0.9, 0.04, 0.04], mask: [1, 0, 0] });
      // Blinker vorn/hinten (bernstein), nur an wenn aktiv
      lights.push({ geo: new THREE.BoxGeometry(0.1, 0.07, 0.07).translate(x * (W / 2 - 0.06), 0.66, -L / 2 + 0.06), color: [1, 0.5, 0.04], mask: [0, x < 0 ? 1 : 0, x > 0 ? 1 : 0] });
      lights.push({ geo: new THREE.BoxGeometry(0.1, 0.07, 0.06).translate(x * (W / 2 - 0.05), 0.66, L / 2 + 0.0), color: [1, 0.5, 0.04], mask: [0, x < 0 ? 1 : 0, x > 0 ? 1 : 0] });
    }
  }
  // Lack-Maske: nur Karosserieteile nehmen die Instanzfarbe an (Glas, Reifen, Kennzeichen nicht)
  const merged = mergeParts(parts), mask = new Float32Array(merged.attributes.position.count);
  let o = 0;
  for (const p of parts) { const n = p.geo.index ? p.geo.index.count : p.geo.attributes.position.count; if (p.paint) mask.fill(1, o, o + n); o += n; }
  merged.setAttribute('paint', new THREE.BufferAttribute(mask, 1));
  // Licht-Maske je Vertex: (Rücklicht, Blinker links, Blinker rechts) – per Instanzfarbe geschaltet
  const lm = mergeParts(lights), lmask = new Float32Array(lm.attributes.position.count * 3);
  o = 0;
  for (const p of lights) { const n = p.geo.index ? p.geo.index.count : p.geo.attributes.position.count; if (p.mask) for (let i = o; i < o + n; i++) lmask.set(p.mask, i * 3); o += n; }
  lm.setAttribute('lmask', new THREE.BufferAttribute(lmask, 3));
  return { type, ...s, body: merged, lights: lm, glass: glassParts.length ? mergeParts(glassParts) : null, inertia: s.mass * (L * L + W * W) / 12 };
}

/**
 * Verkehrs-KI: Autos fahren auf ihren Fahrspuren entlang des Straßengraphen,
 * halten Abstand, halten an roten Ampeln, gewähren an Einmündungen Vorfahrt,
 * bremsen/weichen dem Spieler aus. Angefahren werden sie „lose“ und rutschen
 * physikalisch weg (Phase 5 erweitert das mit Überschlägen).
 */
class TrafficSystem {
  constructor(world, scene, count, parked = 0) {
    this.w = world; this.rng = mulberry32(4242); this.cars = [];
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.36, metalness: 0.3 });
    this.bodyMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float paint;')
        .replace('#include <color_vertex>', THREE.ShaderChunk.color_vertex.replace('vColor.xyz *= instanceColor.xyz;', 'vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, paint);'));
    };
    this.lightMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    // Instanzfarbe: r = Rücklicht-Helligkeit (Bremse), g/b = Blinker links/rechts (0 aus … 1 an)
    this.lightMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 lmask;')
        .replace('#include <color_vertex>', THREE.ShaderChunk.color_vertex.replace('vColor.xyz *= instanceColor.xyz;',
          'vColor.xyz *= mix(1.0, instanceColor.r, lmask.x); vColor.xyz *= 1.0 - (lmask.y * (1.0 - instanceColor.g) + lmask.z * (1.0 - instanceColor.b)) * 0.88;'));
    };
    const types = Object.keys(TRAFFIC_TYPES);
    this.variants = types.map((t) => makeTrafficVariant(t));
    const pick = () => { let r = this.rng(), acc = 0; for (let i = 0; i < types.length; i++) { acc += TRAFFIC_TYPES[types[i]].weight; if (r <= acc) return i; } return 0; };
    const chosen = Array.from({ length: count }, pick);
    // geparkte Autos (keine Lkw) am Straßenrand der Stadt
    for (let k = 0; k < parked; k++) { let t; do { t = pick(); } while (types[t] === 'truck'); chosen.push(t); }
    for (const v of this.variants) {
      const n = Math.max(1, chosen.filter((i) => this.variants[i] === v).length);
      v.bodyMesh = new THREE.InstancedMesh(v.body, this.bodyMat, n);
      v.lightMesh = new THREE.InstancedMesh(v.lights, this.lightMat, n);
      if (v.glass) {
        this.glassMat = this.glassMat || new THREE.MeshStandardMaterial({ color: 0x0c1016, roughness: 0.06, metalness: 0.35, transparent: true, opacity: 0.6, envMapIntensity: 1.3 });
        v.glassMesh = new THREE.InstancedMesh(v.glass, this.glassMat, n); v.glassMesh.renderOrder = 2;
        v.glassMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); v.glassMesh.frustumCulled = false; v.glassMesh.count = 0; scene.add(v.glassMesh);
      }
      for (const im of [v.bodyMesh, v.lightMesh]) { im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.frustumCulled = false; im.count = 0; scene.add(im); }
      v.bodyMesh.castShadow = true;
      v.n = 0;
    }
    const col = new THREE.Color();
    for (const vi of chosen) {
      const v = this.variants[vi];
      const car = { v, slot: v.n++, e: null, s: 0, dir: 1, lane: 0, speed: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
        state: 'drive', vx: 0, vz: 0, yawRate: 0, stopT: 0, cleared: false, waitT: 0, latOff: 0, bx: 0, bz: 0,
        pers: 0.85 + this.rng() * 0.25 };
      const p = v.type === 'truck' ? [0.9, 0.9, 0.9] : CAR_PAINTS[Math.floor(this.rng() * CAR_PAINTS.length)];
      v.bodyMesh.setColorAt(car.slot, col.setRGB(p[0], p[1], p[2], THREE.SRGBColorSpace));
      v.lightMesh.setColorAt(car.slot, col.setRGB(1, 0, 0));
      car.idx = this.cars.length;
      car.parked = car.idx >= count;
      this.cars.push(car);
    }
    for (const c of this.cars) if (c.parked) this.placeParked(c, true);
    for (const v of this.variants) { v.bodyMesh.count = v.n; v.lightMesh.count = v.n; if (v.glassMesh) v.glassMesh.count = v.n; }
    this.blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: makeBlobTexture(), color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }), this.cars.length);
    // Lichthöfe der Scheinwerfer/Rücklichter (nachts), ein Draw-Call für alle
    const N = this.cars.length * 4;
    this.glowGeo = new THREE.BufferGeometry();
    this.glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.glowGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.glow = new THREE.Points(this.glowGeo, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'), size: 1.7, vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    this.glow.frustumCulled = false; this.glow.visible = false; scene.add(this.glow);
    this.blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.blobs.frustumCulled = false; this.blobs.renderOrder = 1;
    scene.add(this.blobs);
    this._up = new THREE.Vector3(0, 1, 0); this._bs = new THREE.Vector3();
    // Kanten nach Länge gewichtet für zufällige Startpunkte
    this.edgeCum = []; let acc = 0;
    for (const e of world.edges) { acc += e.len; this.edgeCum.push(acc); }
    this.edgeTotal = acc;
    this._p = {}; this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._pos = new THREE.Vector3(); this._one = new THREE.Vector3(1, 1, 1);
  }

  setNight(on) { this.lightMat.color.setScalar(on ? 4 : 1.2); this.glow.visible = on; }

  /** Parkplatz am Straßenrand einer Stadtstraße suchen (bzw. den alten wieder einnehmen). */
  placeParked(car, fresh) {
    const city = this.w.edges.filter((e) => e.cls === 'city');
    if (fresh || !car.spot) {
      for (let t = 0; t < 40; t++) {
        const e = city[Math.floor(this.rng() * city.length)], s = 24 + this.rng() * (e.len - 48), dir = this.rng() < 0.5 ? 1 : -1;
        if (this.cars.some((o) => o !== car && o.spot && o.spot.e === e && o.spot.dir === dir && Math.abs(o.spot.s - s) < 7)) continue;
        car.spot = { e, s, dir }; break;
      }
    }
    const sp = car.spot;
    Object.assign(car, { e: sp.e, s: sp.s, dir: sp.dir, lane: 0, speed: 0, state: 'parked', latOff: 5.45 - car.v.W / 2 + 0.92 - sp.e.C.lanes[0], body: null, stopT: 0 });
    this.place(car, 0, true);
  }

  randomEdge() {
    const r = this.rng() * this.edgeTotal;
    let lo = 0, hi = this.edgeCum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.edgeCum[mid] < r) lo = mid + 1; else hi = mid; }
    return this.w.edges[lo];
  }

  respawn(car, focus, rMin, rMax, camera) {
    // Kanten in der Nähe des Spielers bevorzugen (bei hoher Dichte findet zufälliges Suchen auf der ganzen Karte sonst nichts)
    const near = this.nearEdges(focus, rMax);
    for (let t = 0; t < 90; t++) {
      const e = near.length && t < 70 ? near[Math.floor(this.rng() * near.length)] : this.randomEdge();
      if (car.v.type === 'truck' && e.cls === 'city') continue;
      const s = 10 + this.rng() * Math.max(e.len - 20, 1);
      const p = this.w.pointOnEdge(e, s, this._p);
      const d = Math.hypot(p.x - focus.x, p.z - focus.z);
      if (d < rMin || d > rMax || p.y < this.w.waterLevel - 1) continue;
      if (camera && d < 200 && this.inView(camera, p)) continue;     // nicht vor den Augen erscheinen
      const dir = this.rng() < 0.5 ? 1 : -1, lane = Math.floor(this.rng() * e.C.lanes.length);
      let free = true;
      for (const o of this.cars) if (o !== car && o.e === e && Math.abs(o.s - s) < 18) { free = false; break; }
      if (!free) continue;
      Object.assign(car, { e, s, dir, lane, state: 'drive', speed: e.C.speed[lane] * car.pers * 0.8, cleared: false, waitT: 0, stopT: 0, latOff: 0, bx: 0, bz: 0, yawRate: 0 });
      this.place(car, 0, true);
      return true;
    }
    // nichts frei: Auto bleibt, wo es war; hatte es noch keine Straße, eine beliebige nehmen (nie ohne Kante lassen)
    if (!car.e) {
      const e = this.randomEdge();
      Object.assign(car, { e, s: e.len / 2, dir: 1, lane: 0, state: 'drive', speed: 0, cleared: false, waitT: 0, stopT: 0, latOff: 0, bx: 0, bz: 0, yawRate: 0 });
      this.place(car, 0, true);
    }
    return false;
  }

  /** Straßenkanten im Umkreis (gecacht, solange sich der Spieler kaum bewegt). */
  nearEdges(focus, r) {
    const c = this._ne;
    if (c && Math.hypot(c.x - focus.x, c.z - focus.z) < 60 && c.r === r) return c.list;
    const set = new Set();
    this.w.roadPointHash.near(focus.x, focus.z, r, (it) => set.add(it.e));
    this._ne = { x: focus.x, z: focus.z, r, list: [...set] };
    return this._ne.list;
  }

  inView(camera, p) {
    const dx = p.x - camera.position.x, dz = p.z - camera.position.z;
    const f = this._pos.set(0, 0, -1).applyQuaternion(camera.quaternion);
    return (dx * f.x + dz * f.z) / Math.hypot(dx, dz) > 0.5;
  }

  spawnAll(focus) { for (const c of this.cars) if (!c.parked) this.respawn(c, focus, 15, 320); }

  /** Weltposition aus Kante/Spur berechnen (mit weicher Überblendung bei Kantenwechseln). */
  place(car, dt, snap) {
    const p = this.w.pointOnEdge(car.e, car.s, this._p);
    const fx = p.tx * car.dir, fz = p.tz * car.dir, rx = -fz, rz = fx;
    const lat = car.e.C.lanes[car.lane] + car.latOff;
    const x = p.x + rx * lat, z = p.z + rz * lat;
    if (snap) { car.bx = 0; car.bz = 0; }
    else { const k = Math.exp(-dt * 5); car.bx *= k; car.bz *= k; }
    car.x = x + car.bx; car.z = z + car.bz; car.y = p.y + 0.02;
    const yaw = Math.atan2(-fx, -fz);
    if (snap) car.yaw = yaw;
    else { let d = yaw - car.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); car.yaw += d * (1 - Math.exp(-dt * 9)); }
    const L = car.v.L * 0.5;
    const hf = car.e.pts.length > 1 ? this.w.pointOnEdge(car.e, car.s + car.dir * L, {}).y : p.y;
    const hb = this.w.pointOnEdge(car.e, car.s - car.dir * L, {}).y;
    car.pitch = Math.atan2(hf - hb, 2 * L);
  }

  /** Sind auf der Autobahn nahe des Knotens Autos unterwegs? (für Einmündungen) */
  highwayClear(node, player) {
    for (const o of this.cars) {
      if (o.state !== 'drive' || o.e.cls !== 'highway' || (o.e.a !== node && o.e.b !== node)) continue;
      const towards = (o.e.b === node && o.dir > 0) || (o.e.a === node && o.dir < 0);
      const dist = o.e.b === node ? o.e.len - o.s : o.s;
      if (towards && dist < 90) return false;
    }
    return Math.hypot(player.pos.x - node.x, player.pos.z - node.z) > 35;
  }

  /** Nächste Kante an einem Knoten wählen (lieber geradeaus; Lkw nicht in die Stadt). */
  chooseNext(car, e, node, here) {
    const inTx = here.tx * car.dir, inTz = here.tz * car.dir;
    const opts = node.edges.filter((o) => o !== e && !(car.v.type === 'truck' && o.cls === 'city'));
    if (!opts.length) return e;
    let tot = 0; const ws = opts.map((o) => {
      const out = o.a === node ? o.pts[1] : o.pts[o.pts.length - 2];
      const ox2 = out.x - node.x, oz2 = out.z - node.z, l = Math.hypot(ox2, oz2) || 1;
      const wgt = 0.35 + Math.max(0, (ox2 * inTx + oz2 * inTz) / l) * 2.2; tot += wgt; return wgt;
    });
    let r = this.rng() * tot; let k = 0; while (k < ws.length - 1 && r > ws[k]) { r -= ws[k]; k++; }
    return opts[k];
  }

  update(dt, player, camera) {
    this.time = (this.time || 0) + dt;
    const w = this.w;
    for (const car of this.cars) {
      if (car.state === 'loose') { this.updateLoose(car, dt, player, camera); continue; }
      if (car.state === 'parked') continue;
      if (car.blinkT > 0 && (car.blinkT -= dt) <= 0) car.blink = 0;
      const e = car.e, C = e.C;
      const node = car.dir > 0 ? e.b : e.a;
      const toNode = car.dir > 0 ? e.len - car.s : car.s;
      let vT = C.speed[Math.min(car.lane, C.speed.length - 1)] * car.pers;
      // Kurven: vor engen Bögen langsamer (Querbeschleunigung ~3 m/s²)
      const ahead = w.pointOnEdge(e, car.s + car.dir * 30, {}), here = w.pointOnEdge(e, car.s, this._p);
      const dot = clamp(ahead.tx * here.tx + ahead.tz * here.tz, -1, 1);
      const ang = Math.acos(dot);
      if (ang > 0.05) vT = Math.min(vT, Math.sqrt(3.2 * 30 / ang));
      // Kreuzungen
      let stop = Infinity;
      if (toNode < 70 && node.edges.length >= 3) {
        if (node.signal) {
          const axis = Math.abs(here.tx) > Math.abs(here.tz) ? 'EW' : 'NS';
          const st = w.signalState(node, axis);
          if (st === 'R' || (st === 'Y' && toNode > 18)) stop = toNode - C.stopBack;
        } else if (node.type === 'hwj') {
          if (e.cls !== 'highway' && !car.cleared) {
            stop = toNode - C.stopBack;
            if (car.speed < 0.6 && stop < 2) { car.waitT += dt; if (car.waitT > 0.8 && this.highwayClear(node, player)) car.cleared = true; }
          }
        } else if (!car.cleared) {
          stop = toNode - C.stopBack;
          if (car.speed < 0.4 && stop < 2) { car.waitT += dt; if (car.waitT > 1.2) car.cleared = true; }
        }
      }
      if (stop < Infinity) vT = Math.min(vT, stop < 0.5 ? 0 : Math.sqrt(2 * 3.2 * stop));
      // Vordermann
      let gap = Infinity, leadV = 0;
      for (const o of this.cars) {
        if (o === car || o.e !== e || o.dir !== car.dir || o.state !== 'drive') continue;
        if (o.lane !== car.lane && C.lanes.length > 1) continue;
        const ds = (o.s - car.s) * car.dir - (o.v.L + car.v.L) / 2;
        if (ds > -1 && ds < gap) { gap = ds; leadV = o.speed; }
      }
      // Spieler vor dem Auto?
      const dxp = player.pos.x - car.x, dzp = player.pos.z - car.z;
      const fwd = dxp * -Math.sin(car.yaw) + dzp * -Math.cos(car.yaw);
      const lat = dxp * Math.cos(car.yaw) - dzp * Math.sin(car.yaw);
      if (fwd > 0 && fwd < 50 && Math.abs(lat) < 2.8 && Math.abs(player.pos.y - car.y) < 4) {
        const pg = fwd - car.v.L / 2 - 2.5;
        if (pg < gap) { gap = pg; leadV = Math.max(0, player.vel.x * -Math.sin(car.yaw) + player.vel.z * -Math.cos(car.yaw)); }
        // Ausweichen, wenn der Spieler entgegenkommt
        const closing = -(player.vel.x * -Math.sin(car.yaw) + player.vel.z * -Math.cos(car.yaw));
        if (closing > 4 && fwd < 35) car.latOff = Math.min(car.latOff + dt * 3, C === ROAD_CLASS.highway ? 2.5 : 1.6);
      } else car.latOff = Math.max(car.latOff - dt * 1.2, 0);
      if (gap < Infinity) vT = Math.min(vT, Math.max(0, leadV + (gap - (5 + car.speed * 0.9)) * 0.55));
      // Beschleunigen / Bremsen
      const dv = vT - car.speed;
      car.speed = Math.max(0, car.speed + clamp(dv, -9 * dt, 2.4 * dt));
      // Bremslicht: beim Verzögern und im Stand (Fuß auf der Bremse)
      car.brakeOn = dv < -0.6 || car.speed < 0.4;
      // Abbiegen vorher festlegen → Blinker ca. 45 m vor der Kreuzung setzen
      if (toNode < 45 && !car.nextE && node.edges.length >= 3) {
        car.nextE = this.chooseNext(car, e, node, here);
        const nE = car.nextE, out = nE.a === node ? nE.pts[1] : nE.pts[nE.pts.length - 2];
        const ox2 = out.x - node.x, oz2 = out.z - node.z, l = Math.hypot(ox2, oz2) || 1;
        const cr = (here.tx * car.dir) * (oz2 / l) - (here.tz * car.dir) * (ox2 / l);   // >0: rechts (Bildschirm-Koordinaten x/z)
        car.blink = Math.abs(cr) > 0.45 ? (cr > 0 ? 1 : -1) : 0;
      }
      car.s += car.dir * car.speed * dt;
      // Kantenende → nächste Kante wählen (lieber geradeaus)
      if (car.s > e.len || car.s < 0) {
        const over = car.s > e.len ? car.s - e.len : -car.s;
        const ox = car.x, oz = car.z;
        const inTx = here.tx * car.dir, inTz = here.tz * car.dir;
        const next = car.nextE || this.chooseNext(car, e, node, here); car.nextE = null; car.blinkT = 2.5;
        const dirN = next.a === node ? 1 : -1;
        car.e = next; car.dir = dirN; car.s = dirN > 0 ? over : next.len - over;
        car.lane = Math.min(car.lane, next.C.lanes.length - 1);
        car.cleared = false; car.waitT = 0;
        this.place(car, 0, true);
        car.bx = ox - car.x; car.bz = oz - car.z;   // Sprung weich ausblenden
        car.x = ox; car.z = oz;
      } else this.place(car, dt, false);
      // weit weg → woanders neu einsetzen
      const dpx = car.x - player.pos.x, dpz = car.z - player.pos.z;
      if (dpx * dpx + dpz * dpz > 440 * 440) this.respawn(car, player.pos, 110, 400, camera);   // dichter Verkehr rund um den Spieler
    }
    this.writeInstances();
  }

  /** Angefahrenes Auto: echter Starrkörper – rutscht, kippt, überschlägt sich. */
  makeLoose(car) {
    if (car.body) return;
    const v = car.v, b = new RigidBox(v.mass, v.W / 2, v.H / 2, v.L / 2);
    this._e.set(car.pitch, car.yaw, 0, 'YXZ'); b.quat.setFromEuler(this._e);
    b.pos.set(car.x, car.y + v.H / 2, car.z);
    b.vel.set(-Math.sin(car.yaw) * car.speed, 0, -Math.cos(car.yaw) * car.speed);
    car.body = b; car.state = 'loose'; car.stopT = 0; car.bx = car.bz = 0;
  }

  updateLoose(car, dt, player, camera) {
    const b = car.body;
    if (!b) { car.state = 'drive'; return; }
    const n = 3;
    for (let k = 0; k < n; k++) b.step(dt / n, this.w);
    const f = this._pos.set(0, 0, -1).applyQuaternion(b.quat);
    car.yaw = Math.atan2(-f.x, -f.z);
    car.x = b.pos.x; car.z = b.pos.z; car.y = b.pos.y - car.v.H / 2;
    if (b.sleep > 0.5) car.stopT += dt; else car.stopT = 0;
    const d = Math.hypot(car.x - player.pos.x, car.z - player.pos.z);
    const hidden = !this.inView(camera, car);
    if ((car.stopT > 6 && d > 60 && hidden) || (car.stopT > 25 && d > 25) || d > 700 || car.y < this.w.waterLevel - 6) {
      car.body = null;
      if (car.parked) this.placeParked(car, false); else this.respawn(car, player.pos, 110, 400, camera);
    }
  }

  writeInstances() {
    const m = this._m, q = this._q, e = this._e, p = this._pos;
    if (!this._off) this._off = this.variants.map((v) => new THREE.Matrix4().makeTranslation(0, -v.H / 2, 0));
    for (const car of this.cars) {
      if (car.body) {
        m.compose(car.body.pos, car.body.quat, this._one).multiply(this._off[this.variants.indexOf(car.v)]);
      } else {
        e.set(car.pitch, car.yaw, 0, 'YXZ'); q.setFromEuler(e); p.set(car.x, car.y, car.z);
        m.compose(p, q, this._one);
      }
      { const on = Math.sin((this.time || 0) * Math.PI * 3) > 0, drive = car.state === 'drive';
        this._lc = this._lc || new THREE.Color();
        this._lc.setRGB(drive && car.brakeOn ? 3.2 : 1, drive && car.blink < 0 && on ? 1 : 0, drive && car.blink > 0 && on ? 1 : 0);
        car.v.lightMesh.setColorAt(car.slot, this._lc); }
      if (car.v.glassMesh) car.v.glassMesh.setMatrixAt(car.slot, m);
      car.v.bodyMesh.setMatrixAt(car.slot, m); car.v.lightMesh.setMatrixAt(car.slot, car.state === 'parked' ? this._zero || (this._zero = new THREE.Matrix4().makeScale(0, 0, 0)) : m);
      // Kontaktschatten
      const bx = car.body ? car.body.pos.x : car.x, bz = car.body ? car.body.pos.z : car.z;
      const gy = car.body ? this.w.sample(bx, bz) : car.y;
      q.setFromAxisAngle(this._up, car.yaw);
      this._bs.set(car.v.W + 0.5, 1, car.v.L + 0.7);
      m.compose(p.set(bx, gy + 0.04, bz), q, this._bs);
      this.blobs.setMatrixAt(car.idx, m);
    }
    this.blobs.instanceMatrix.needsUpdate = true;
    for (const v of this.variants) if (v.lightMesh.instanceColor) v.lightMesh.instanceColor.needsUpdate = true;
    // Lichthöfe (nur fahrende Autos, nur nachts)
    if (this.glow.visible) {
      const pa = this.glowGeo.attributes.position.array, ca = this.glowGeo.attributes.color.array;
      let k = 0;
      for (const car of this.cars) {
        if (car.state !== 'drive') continue;
        const fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw), rx = -fz, rz = fx, L = car.v.L / 2 + 0.06, W = car.v.W / 2 - 0.3;
        for (const [a, b, y, r, g, bl] of [[L, W, 0.66, 1, 0.95, 0.85], [L, -W, 0.66, 1, 0.95, 0.85], [-L, W, 0.74, 0.9, 0.05, 0.05], [-L, -W, 0.74, 0.9, 0.05, 0.05]]) {
          pa[k * 3] = car.x + fx * a + rx * b; pa[k * 3 + 1] = car.y + y * (car.v.type === 'truck' ? 1.35 : 1); pa[k * 3 + 2] = car.z + fz * a + rz * b;
          ca[k * 3] = r; ca[k * 3 + 1] = g; ca[k * 3 + 2] = bl; k++;
        }
      }
      this.glowGeo.setDrawRange(0, k);
      this.glowGeo.attributes.position.needsUpdate = true; this.glowGeo.attributes.color.needsUpdate = true;
    }
    for (const v of this.variants) { v.bodyMesh.instanceMatrix.needsUpdate = true; v.lightMesh.instanceMatrix.needsUpdate = true; if (v.glassMesh) v.glassMesh.instanceMatrix.needsUpdate = true; }
  }

  /** Spieler gegen Verkehr (Draufsicht-Rechtecke, Impuls mit Drehung auf beiden Seiten). */
  collidePlayer(v) {
    const px = v.pos.x, pz = v.pos.z;
    const f = v._v[11].set(0, 0, -1).applyQuaternion(v.quat);
    let pfx = f.x, pfz = f.z; const fl = Math.hypot(pfx, pfz) || 1; pfx /= fl; pfz /= fl;
    const prx = -pfz, prz = pfx, PHX = 0.98, PHZ = 2.28;
    for (const c of this.cars) {
      const R = c.v.L / 2 + 2.6, dx = c.x - px, dz = c.z - pz;
      if (dx * dx + dz * dz > R * R) continue;
      if (v.pos.y - 0.45 > c.y + c.v.H || v.pos.y + 0.6 < c.y) continue;   // drüber gesprungen
      if (c.body && c.body.sleep > 1.2) c.body.sleep = 0;
      const cfx = -Math.sin(c.yaw), cfz = -Math.cos(c.yaw), crx = -cfz, crz = cfx;
      const CHX = c.v.W / 2, CHZ = c.v.L / 2;
      // Spieler-Ecken im Verkehrsauto
      for (const [lx, lz] of [[-PHX, -PHZ], [PHX, -PHZ], [-PHX, PHZ], [PHX, PHZ], [0, -PHZ], [0, PHZ]]) {
        const x = px + prx * lx - pfx * lz, z = pz + prz * lx - pfz * lz;
        const ax = (x - c.x) * crx + (z - c.z) * crz, az = -((x - c.x) * cfx + (z - c.z) * cfz);
        if (Math.abs(ax) >= CHX || Math.abs(az) >= CHZ) continue;
        const ddx = CHX - Math.abs(ax), ddz = CHZ - Math.abs(az);
        const sx = Math.sign(ax), sz = -Math.sign(az);
        this.pickAxis(v, c, x, z, crx * sx, crz * sx, ddx, cfx * sz, cfz * sz, ddz);
      }
      // Ecken des Verkehrsautos im Spieler
      for (const [lx, lz] of [[-CHX, -CHZ], [CHX, -CHZ], [-CHX, CHZ], [CHX, CHZ]]) {
        const x = c.x + crx * lx - cfx * lz, z = c.z + crz * lx - cfz * lz;
        const ax = (x - px) * prx + (z - pz) * prz, az = -((x - px) * pfx + (z - pz) * pfz);
        if (Math.abs(ax) >= PHX || Math.abs(az) >= PHZ) continue;
        const ddx = PHX - Math.abs(ax), ddz = PHZ - Math.abs(az);
        const sx = -Math.sign(ax), sz = Math.sign(az);
        this.pickAxis(v, c, x, z, prx * sx, prz * sx, ddx, pfx * sz, pfz * sz, ddz);
      }
    }
  }

  /**
   * Ecken-Kontakt: von zwei möglichen Trennachsen die nehmen, entlang der sich
   * die Autos tatsächlich annähern (sonst „rutscht“ man an Ecken hindurch).
   */
  pickAxis(v, c, x, z, n1x, n1z, d1, n2x, n2z, d2) {
    const cvx = c.body ? c.body.vel.x : -Math.sin(c.yaw) * c.speed, cvz = c.body ? c.body.vel.z : -Math.cos(c.yaw) * c.speed;
    const rvx = v.vel.x - cvx, rvz = v.vel.z - cvz;
    const a1 = rvx * n1x + rvz * n1z < -0.5, a2 = rvx * n2x + rvz * n2z < -0.5;
    let use1 = d1 <= d2;
    if (use1 && !a1 && a2 && d2 < 1.6) use1 = false;
    else if (!use1 && !a2 && a1 && d1 < 1.6) use1 = true;
    if (use1) this.resolvePair(v, c, x, z, n1x, n1z, d1); else this.resolvePair(v, c, x, z, n2x, n2z, d2);
  }

  /** n zeigt vom Verkehrsauto zum Spieler. Impuls in 3D: die flache Front hebelt das Auto an. */
  resolvePair(v, c, x, z, nx, nz, depth) {
    this.makeLoose(c);
    const b = c.body, m2 = c.v.mass, wP = m2 / (m2 + v.mass);
    v.pos.x += nx * depth * wP; v.pos.z += nz * depth * wP;
    b.pos.x -= nx * depth * (1 - wP); b.pos.z -= nz * depth * (1 - wP);
    const t = v._v;
    const P = t[3].set(x, Math.min(v.pos.y - 0.12, b.pos.y - 0.25), z);   // Stoß auf Stoßfängerhöhe
    const r1 = t[4].subVectors(P, v.pos);
    const v1 = t[6].crossVectors(v.angVel, r1).add(v.vel);
    const v2 = b.pointVel(P, t[9]);
    const vn = (v1.x - v2.x) * nx + (v1.z - v2.z) * nz;
    if (vn >= 0) return;
    const lift = clamp(-vn * 0.01, 0, 0.18);
    const n = t[5].set(nx, -lift, nz).normalize();
    const rn = t[7].crossVectors(r1, n);
    const k1 = v.invMass + v.applyInvInertia(t[8].copy(rn)).cross(r1).dot(n);
    const k2 = b.effInv(t[2].subVectors(P, b.pos), n);
    const j = -(1 + 0.18) * vn / (k1 + k2);
    const J = t[8].copy(n).multiplyScalar(j);
    v.vel.addScaledVector(J, v.invMass);
    v.angVel.add(v.applyInvInertia(t[9].crossVectors(r1, J)));
    b.impulse(J.negate(), P);
    // Keil-Effekt: die flache Front schiebt sich bei harten Treffern unter das Auto → kann es aushebeln
    const now = performance.now();
    if (-vn > 13 && !(c.wedgeT > now)) {             // nur einmal pro Zusammenstoß
      c.wedgeT = now + 600;
      b.impulse(t[2].set(0, Math.min(-vn - 13, 14) * m2 * 0.05, 0), P);
    }
    if (-vn > 2) {
      v.lastImpact = Math.max(v.lastImpact, -vn);
      if (this.w.fx.length < 30) this.w.fx.push({ type: 'spark', x, y: P.y, z, s: -vn, nx, nz });
    }
  }
}

export { TRAFFIC_TYPES, CAR_PAINTS, makeTrafficVariant, TrafficSystem };
