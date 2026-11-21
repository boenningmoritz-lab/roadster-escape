import * as THREE from 'three';
import { clamp } from '../config.js';
import { mulberry32 } from './noise.js';
import { ROAD_CLASS, mergeParts, makeBlobTexture, radialTexture } from './world.js';
import { RigidBox } from '../fx.js';

// ============================== Verkehr ==============================
const TRAFFIC_TYPES = {
  // Sechs Modelle: Kleinwagen, Limousine, Kombi, SUV, Transporter, Lkw (Gewicht = Anteil im Verkehr)
  hatch: { L: 3.95, W: 1.74, H: 1.5, hood: 0.85, trunk: 0.15, wr: 0.31, mass: 1150, weight: 0.24 },
  sedan: { L: 4.75, W: 1.84, H: 1.45, hood: 1.15, trunk: 0.85, wr: 0.33, mass: 1450, weight: 0.25 },
  kombi: { L: 4.85, W: 1.84, H: 1.5, hood: 1.1, trunk: 0.12, wr: 0.33, mass: 1550, weight: 0.17, longRoof: true, passenger: true },
  suv:   { L: 4.8, W: 1.95, H: 1.78, hood: 1.05, trunk: 0.3, wr: 0.38, mass: 2050, weight: 0.16, passenger: true },
  van:   { L: 5.3, W: 2.0, H: 2.35, hood: 0.75, trunk: 0.05, wr: 0.35, mass: 2400, weight: 0.1, tall: true, passenger: true },
  truck: { L: 8.4, W: 2.5, H: 3.4, wr: 0.5, mass: 9000, weight: 0.08 },
};
// Realistische Lackverteilung: viel Weiß/Silber/Grau/Schwarz, dazu einige kräftige Metallic-Farben
const CAR_PAINTS = [[0.92, 0.92, 0.92], [0.94, 0.94, 0.92], [0.66, 0.68, 0.7], [0.72, 0.73, 0.75], [0.1, 0.1, 0.11], [0.06, 0.06, 0.07],
  [0.3, 0.32, 0.34], [0.42, 0.44, 0.46], [0.12, 0.2, 0.36], [0.08, 0.18, 0.5], [0.55, 0.08, 0.09], [0.7, 0.06, 0.05],
  [0.7, 0.6, 0.45], [0.16, 0.3, 0.2], [0.85, 0.85, 0.82], [0.2, 0.22, 0.25], [0.85, 0.42, 0.1], [0.2, 0.4, 0.55], [0.38, 0.25, 0.18]];

/** Getöntes Autoglas: von vorn durchsichtig (Innenraum und Insassen sichtbar), im flachen Winkel stark spiegelnd (Fresnel). */
function makeCarGlass() {
  const m = new THREE.MeshStandardMaterial({ color: 0x1b232c, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.26, envMapIntensity: 1.5, depthWrite: false });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', '{ float fres = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 3.0); diffuseColor.a = mix(diffuseColor.a, 0.92, fres); }\n#include <lights_fragment_begin>');
  };
  return m;
}

/** Modell eines Verkehrsautos als eine Geometrie (Karosserie weiß → per Instanzfarbe lackiert). */
// lo = true: vereinfachte Fern-Version (LOD) – grobe Karosserie, Scheiben deckend, ohne Innenraum/Felgen/Kleinteile
function makeTrafficVariant(type, spec = TRAFFIC_TYPES[type], lo = false) {
  const s = spec, L = s.L, W = s.W, Hh = s.H;
  const BODY = [0.93, 0.93, 0.93], GLASS = [0.07, 0.08, 0.1], DARK = [0.06, 0.06, 0.07], RIM = [0.55, 0.56, 0.58];
  const parts = [], lights = [], glassParts = [];
  const extrude = (pts, width, bevel) => {
    const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    const depth = width - bevel * 2;
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 1, curveSegments: 2 });
    g.translate(0, 0, -depth / 2); g.rotateY(-Math.PI / 2); g.computeVertexNormals();
    return g;
  };
  // Insasse: sitzende Figur (Oberkörper, Hals, Kopf, Haare, Arme zum Lenkrad), Blick nach vorn (−z).
  // hy = Kopfhöhe, zs = Sitz (Rücken), zw = Lenkrad-z (null → Beifahrer, Hände im Schoß)
  const SKIN = [[0.86, 0.68, 0.56], [0.62, 0.45, 0.33], [0.42, 0.29, 0.2], [0.9, 0.75, 0.62]], SHIRT = [[0.2, 0.24, 0.32], [0.62, 0.62, 0.6], [0.45, 0.12, 0.12], [0.12, 0.3, 0.22], [0.08, 0.08, 0.09], [0.75, 0.7, 0.55]];
  const HAIR = [[0.12, 0.08, 0.05], [0.3, 0.2, 0.1], [0.55, 0.45, 0.3], [0.06, 0.05, 0.05], [0.45, 0.45, 0.46]];
  const pick = (arr, k) => arr[Math.abs(Math.round(k)) % arr.length];
  const limb = (a, b, r, color) => {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), len = va.distanceTo(vb);
    const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - r), 2, 6);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize()));
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    parts.push({ geo: g, color });
  };
  const person = (x, hy, zs, zw, seed) => {
    const skin = pick(SKIN, seed), shirt = pick(SHIRT, seed * 7 + 3), hair = pick(HAIR, seed * 3 + 1);
    const sy = hy - 0.27;                                                                   // Schulterhöhe
    parts.push({ geo: new THREE.CapsuleGeometry(0.16, 0.3, 3, 8).scale(1.3, 1, 0.72).translate(x, sy - 0.2, zs), color: shirt });   // Oberkörper
    parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.055, 0.12, 8).translate(x, sy + 0.05, zs - 0.01), color: skin });            // Hals
    parts.push({ geo: new THREE.SphereGeometry(0.1, 12, 10).scale(0.88, 1.1, 0.98).translate(x, hy, zs - 0.02), color: skin });       // Kopf
    parts.push({ geo: new THREE.SphereGeometry(0.105, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.92, 1.05, 1.04).translate(x, hy + 0.012, zs + 0.0), color: hair });   // Haare
    for (const sx of [-1, 1]) {
      const sh = [x + sx * 0.2, sy - 0.02, zs], el = [x + sx * 0.23, sy - 0.27, zs - 0.2];
      const hand = zw !== null ? [x + sx * 0.16, sy - 0.17, zw + 0.03] : [x + sx * 0.1, sy - 0.42, zs - 0.3];
      limb(sh, el, 0.05, shirt); limb(el, hand, 0.042, zw !== null ? shirt : skin);
      parts.push({ geo: new THREE.SphereGeometry(0.04, 6, 5).translate(...hand), color: skin });
    }
  };
  const steering = (x, y, z, tilt) => {
    parts.push({ geo: new THREE.TorusGeometry(0.18, 0.02, 6, 18).rotateX(tilt).translate(x, y, z), color: [0.05, 0.05, 0.06] });
    parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, 0.05, 10).rotateX(tilt + Math.PI / 2).translate(x, y, z), color: [0.08, 0.08, 0.09] });
  };
  const wheel = (x, z, r) => {
    parts.push({ geo: new THREE.CylinderGeometry(r, r, 0.26, 14).rotateZ(Math.PI / 2).translate(x, r, z), color: DARK });
    parts.push({ geo: new THREE.CylinderGeometry(r * 0.6, r * 0.6, 0.27, 10).rotateZ(Math.PI / 2).translate(x * 1.005, r, z), color: RIM });
  };
  if (type === 'truck') {
    const cabL = 2.3;
    // Kabine als Hülle: Unterteil, Dach, Rückwand, Säulen – dazwischen echte Scheiben (vorn und seitlich), dahinter Innenraum
    const cz = -L / 2 + cabL / 2, gy0 = 1.95, gy1 = 2.8;
    parts.push({ geo: new THREE.BoxGeometry(W, gy0 - 0.6, cabL).translate(0, (0.6 + gy0) / 2, cz), color: BODY, paint: true });
    parts.push({ geo: new THREE.BoxGeometry(W, 3.0 - gy1, cabL).translate(0, (gy1 + 3.0) / 2, cz), color: BODY, paint: true });
    parts.push({ geo: new THREE.BoxGeometry(W, gy1 - gy0, 0.08).translate(0, (gy0 + gy1) / 2, -L / 2 + cabL - 0.04), color: BODY, paint: true });
    for (const x of [-1, 1]) for (const z of [-L / 2 + 0.06, -L / 2 + cabL - 0.1]) parts.push({ geo: new THREE.BoxGeometry(0.1, gy1 - gy0, 0.12).translate(x * (W / 2 - 0.05), (gy0 + gy1) / 2, z), color: BODY, paint: true });
    const gl = [new THREE.BoxGeometry(W - 0.18, gy1 - gy0, 0.02).translate(0, (gy0 + gy1) / 2, -L / 2 + 0.03)];
    for (const x of [-1, 1]) gl.push(new THREE.BoxGeometry(0.02, gy1 - gy0 - 0.04, cabL - 0.3).translate(x * (W / 2 - 0.02), (gy0 + gy1) / 2, cz - 0.03));
    for (const g of gl) { if (lo) parts.push({ geo: g, color: GLASS }); else glassParts.push({ geo: g, color: [1, 1, 1] }); }
    if (!lo) {
      parts.push({ geo: new THREE.BoxGeometry(W - 0.2, 0.3, 0.45).translate(0, gy0 + 0.05, -L / 2 + 0.3), color: [0.1, 0.1, 0.11] });   // Armaturenbrett
      for (const x of [-0.6, 0.6]) parts.push({ geo: new THREE.BoxGeometry(0.55, 0.75, 0.14).translate(x, gy0 + 0.25, -L / 2 + 1.55), color: [0.14, 0.14, 0.15] });   // Sitzlehnen
      steering(-0.6, gy0 + 0.28, -L / 2 + 0.72, -0.9);
      person(-0.6, gy0 + 0.72, -L / 2 + 1.42, -L / 2 + 0.72, 2);
    }
    parts.push({ geo: new THREE.BoxGeometry(W + 0.04, 2.9, L - cabL - 0.25).translate(0, 0.75 + 1.45, L / 2 - (L - cabL - 0.25) / 2), color: [0.85, 0.86, 0.87] });
    parts.push({ geo: new THREE.BoxGeometry(W - 0.3, 0.35, L - 0.4).translate(0, 0.55, 0), color: DARK });
    for (const z of [-L / 2 + 1.3, L / 2 - 2.4, L / 2 - 1.2]) for (const x of [-1, 1]) wheel(x * (W / 2 - 0.25), z, s.wr);
    parts.push({ geo: new THREE.BoxGeometry(0.52, 0.12, 0.03).translate(0, 0.62, -L / 2 - 0.03), color: [0.9, 0.9, 0.86] });
    parts.push({ geo: new THREE.BoxGeometry(0.52, 0.12, 0.03).translate(0, 0.62, L / 2 + 0.03), color: [0.9, 0.9, 0.86] });
    for (const x of [-1, 1]) {
      lights.push({ geo: new THREE.BoxGeometry(0.4, 0.18, 0.04).translate(x * (W / 2 - 0.35), 0.95, -L / 2 - 0.02), color: [1, 0.96, 0.88] });
      lights.push({ geo: new THREE.BoxGeometry(0.3, 0.2, 0.04).translate(x * (W / 2 - 0.25), 0.9, L / 2 + 0.02), color: [0.9, 0.04, 0.04], mask: [1, 0, 0] });
      for (const z of [-L / 2 - 0.02, L / 2 + 0.02]) lights.push({ geo: new THREE.BoxGeometry(0.18, 0.12, 0.04).translate(x * (W / 2 - 0.08), 1.15, z), color: [1, 0.5, 0.04], mask: [0, x < 0 ? 1 : 0, x > 0 ? 1 : 0] });
    }
  } else {
    // ---------- Karosserie als glatte Loft-Fläche (Querschnitte entlang der Länge, gerundet) ----------
    // z vorn = −L/2. Unterer Körper mit Motorhaube/Kofferraum, darüber Glashaus (Scheiben) und lackiertes Dach.
    const zf = -L / 2 + 0.9, zr = L / 2 - 0.85, R = s.wr + 0.07;
    const hatch = s.trunk < 0.5, suv = type === 'suv' || !!s.tall;
    const z0 = -L / 2 + s.hood, z1 = L / 2 - s.trunk;              // Windschutzscheibe unten / Heckscheibe unten
    const sm = (a2, b2, x) => { const t = clamp((x - a2) / (b2 - a2), 0, 1); return t * t * (3 - 2 * t); };
    const halfW = (z) => { const u = Math.abs(z) / (L / 2); return W / 2 * (1 - 0.16 * Math.pow(u, 7)); };
    const belt = s.tall ? 1.1 : suv ? 1.0 : 0.88;
    const topY = (z) => {                                           // Oberkante: Haube → Gürtellinie → Kofferraum
      let y = (suv ? 0.72 : 0.6) + (belt - (suv ? 0.72 : 0.6)) * sm(-L / 2, -L / 2 + s.hood * 0.75, z);
      if (!hatch) y -= 0.1 * sm(L / 2 - 0.35, L / 2, z); else y -= 0.03 * sm(L / 2 - 0.12, L / 2, z);
      return y;
    };
    const botY = (z, outer) => {                                    // Unterkante mit Radausschnitten
      let y = 0.3 + 0.06 * Math.max(sm(L / 2 - 0.3, L / 2, z), sm(-L / 2 + 0.3, -L / 2, z));
      if (outer) for (const zw of [zf, zr]) { const d = Math.abs(z - zw); if (d < R) y = Math.max(y, s.wr + Math.sqrt(R * R - d * d)); }
      return y;
    };
    const aLen = s.tall ? 0.45 : suv ? 0.75 : 0.95, cLen = s.tall ? 0.08 : s.longRoof ? 0.15 : hatch ? 0.35 : 0.75;
    const roofY = (z) => belt + (Hh - belt) * sm(z0, z0 + aLen, z) * (1 - sm(z1 - cLen, z1, z));
    const loft = (zs, sec) => {
      const pos = [], idx = []; let N = 0;
      for (const z of zs) {
        const h2 = sec(z), ring = [...h2, ...h2.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
        N = ring.length; for (const [x, y] of ring) pos.push(x, y, z);
      }
      for (let i = 0; i < zs.length - 1; i++) for (let k = 0; k < N; k++) {
        const a3 = i * N + k, b3 = i * N + (k + 1) % N, c3 = a3 + N, d3 = b3 + N;
        idx.push(a3, b3, c3, b3, d3, c3);   // Außenseite zeigt nach außen
      }
      // Enden schließen (Fächer um den Mittelpunkt)
      for (const [ri, flip] of [[0, true], [zs.length - 1, false]]) {
        let cx = 0, cy = 0; for (let k = 0; k < N; k++) { cx += pos[(ri * N + k) * 3]; cy += pos[(ri * N + k) * 3 + 1]; }
        const c = pos.length / 3; pos.push(cx / N, cy / N, zs[ri]);
        for (let k = 0; k < N; k++) { const a4 = ri * N + k, b4 = ri * N + (k + 1) % N; if (flip) idx.push(c, a4, b4); else idx.push(c, b4, a4); }
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      return g;
    };
    const stations = (a5, b5, n, dense = true) => Array.from({ length: n + 1 }, (_, i) => { const t = i / n; const u = dense ? (1 - Math.cos(t * Math.PI)) / 2 : t; return a5 + (b5 - a5) * u; });
    const zsBody = lo ? [...stations(-L / 2, -L / 2 + 0.6, 2), ...stations(-L / 2 + 0.65, L / 2 - 0.65, 6, false), ...stations(L / 2 - 0.6, L / 2, 2)]
      : [...stations(-L / 2, -L / 2 + 0.6, 6), ...stations(-L / 2 + 0.65, L / 2 - 0.65, 26, false), ...stations(L / 2 - 0.6, L / 2, 6)];
    const body = loft(zsBody, (z) => {
      const w = halfW(z), yt = topY(z), yb = botY(z, true), yb0 = botY(z, false);
      const nose = Math.max(sm(-L / 2 + 0.18, -L / 2, z), sm(L / 2 - 0.18, L / 2, z));   // Enden rund einziehen
      const wn = w * (1 - 0.1 * nose);
      return [[0, yb0], [wn * 0.86, yb], [wn * 0.99, yb + 0.08], [wn, (yb + yt) / 2], [wn * 0.985, yt - 0.08], [wn * 0.93, yt - 0.015], [wn * 0.72, yt + 0.02], [wn * 0.35, yt + 0.035 - 0.02 * nose], [0, yt + 0.04 - 0.02 * nose]];
    });
    parts.push({ geo: body, color: BODY, paint: true });
    // Glashaus: getönte Scheiben, nach oben eingezogen (Tumblehome)
    const zsG = stations(z0, z1, lo ? 6 : 22, false);
    const glass = loft(zsG, (z) => {
      const w = halfW(z), yt = topY(z) + 0.02, yr = roofY(z);
      return [[0, yt], [w * 0.9, yt], [w * 0.84, yt + (yr - yt) * 0.5], [w * 0.74, yr], [0, yr + 0.02]];
    });
    if (lo) parts.push({ geo: glass, color: GLASS }); else glassParts.push({ geo: glass, color: [1, 1, 1] });
    // Lackiertes Dach über dem Glashaus + A-/B-/C-Säulen
    // Dachlinie: Transporter fast über die ganze Länge, Kombi mit langem Dach bis ans Heck
    const ra = z0 + aLen, rb = z1 - cLen;
    parts.push({ geo: loft(stations(ra - 0.05, rb + 0.05, lo ? 3 : 12, false), (z) => { const w = halfW(z), yr = roofY(z); return [[0, yr + 0.01], [w * 0.76, yr + 0.005], [w * 0.74, yr + 0.035], [w * 0.4, yr + 0.06], [0, yr + 0.065]]; }), color: BODY, paint: true });
    if (!lo) for (const sx of [-1, 1]) {
      const pil = (za, zb) => { const pts = []; for (let i = 0; i <= 8; i++) { const z = za + (zb - za) * i / 8, w = halfW(z), yt = topY(z) + 0.02, yr = roofY(z), t = (yr - yt) / Math.max(Hh - belt, 0.01); pts.push(new THREE.Vector3(sx * w * (0.9 - 0.16 * t), yt + (yr - yt), z)); } return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.035, 5, false); };
      parts.push({ geo: pil(z0 + 0.02, ra + 0.02), color: BODY, paint: true });          // A-Säule
      parts.push({ geo: pil(rb - 0.02, z1 - 0.02), color: BODY, paint: true });          // C-Säule
      const bz = (ra + rb) / 2 - 0.1, bw = halfW(bz);
      parts.push({ geo: new THREE.BoxGeometry(0.06, Hh - belt, 0.1).translate(sx * bw * 0.82, (Hh + belt) / 2, bz), color: DARK });   // B-Säule
      // Chromleiste an der Fensterunterkante
      parts.push({ geo: new THREE.BoxGeometry(0.02, 0.025, z1 - z0 - 0.2).translate(sx * halfW(0) * 0.905, belt + 0.03, (z0 + z1) / 2), color: [0.7, 0.72, 0.75] });
    }
    // Innenraum hinter den Scheiben: Boden auf Brüstungshöhe, Sitzlehnen, Fahrer (links), Kopfstützen
    const zs = -L / 2 + s.hood + 1.25;
    if (!lo) {
    parts.push({ geo: new THREE.BoxGeometry(W - 0.3, 0.04, L - s.hood - s.trunk - 0.6).translate(0, belt - 0.06, (-L / 2 + s.hood + L / 2 - s.trunk) / 2), color: [0.08, 0.08, 0.09] });
    for (const sx of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(0.46, 0.5, 0.1).translate(sx * 0.4, 1.0, zs + 0.28), color: [0.12, 0.12, 0.13] });
      parts.push({ geo: new THREE.BoxGeometry(0.24, 0.14, 0.09).translate(sx * 0.4, Hh - 0.16, zs + 0.3), color: [0.12, 0.12, 0.13] });
    }
    // Armaturenbrett, Lenkrad, Fahrer (links) und bei größeren Autos ein Beifahrer
    parts.push({ geo: new THREE.BoxGeometry(W - 0.3, 0.18, 0.35).translate(0, belt + 0.02, -L / 2 + s.hood + 0.3), color: [0.09, 0.09, 0.1] });
    steering(-0.4, belt + 0.12, zs - 0.42, -1.15);
    const seed = type.length * 3 + Math.round(L * 10);
    person(-0.4, Hh - 0.3, zs + 0.06, zs - 0.42, seed);
    if (s.passenger) person(0.4, Hh - 0.31, zs + 0.06, null, seed + 5);
    }
    // Radhausschalen (verhindern Durchblick), Stoßfänger, Grill, Kennzeichen, Spiegel
    for (const z of [zf, zr]) parts.push({ geo: new THREE.BoxGeometry(W - 0.12, R * 0.9, R * 2).translate(0, s.wr + R * 0.6, z), color: DARK });
    parts.push({ geo: new THREE.BoxGeometry(W - 0.1, 0.16, 0.1).translate(0, 0.36, -L / 2 + 0.01), color: DARK });
    parts.push({ geo: new THREE.BoxGeometry(W - 0.1, 0.16, 0.1).translate(0, 0.38, L / 2 - 0.02), color: DARK });
    parts.push({ geo: new THREE.BoxGeometry(W * 0.46, 0.15, 0.06).translate(0, 0.6, -L / 2 - 0.01), color: [0.03, 0.03, 0.035] });
    if (!lo) parts.push({ geo: new THREE.BoxGeometry(0.52, 0.12, 0.03).translate(0, 0.42, -L / 2 - 0.06), color: [0.9, 0.9, 0.86] });
    if (!lo) parts.push({ geo: new THREE.BoxGeometry(0.52, 0.12, 0.03).translate(0, 0.56, L / 2 + 0.04), color: [0.9, 0.9, 0.86] });
    if (!lo) for (const x of [-1, 1]) {
      parts.push({ geo: new THREE.BoxGeometry(0.2, 0.12, 0.1).translate(x * (W / 2 + 0.02), belt + 0.1, -L / 2 + s.hood + 0.25), color: BODY, paint: true });
      parts.push({ geo: new THREE.BoxGeometry(0.06, 0.1, 0.06).translate(x * (W / 2 - 0.12), belt + 0.05, -L / 2 + s.hood + 0.25), color: DARK });
    }
    for (const z of [zf, zr]) for (const x of [-1, 1]) {
      const wx = x * (W / 2 - 0.16), r = s.wr;
      parts.push({ geo: new THREE.CylinderGeometry(r, r, 0.24, lo ? 8 : 18).rotateZ(Math.PI / 2).translate(wx, r, z), color: DARK });
      if (lo) continue;
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
      // Dellen: idmg = (Aufprallpunkt x, z lokal, Stärke 0–1, –) → lackierte Teile nahe dem Aufprallpunkt nach innen gedrückt
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float paint;\nattribute vec4 idmg;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n { float dd = distance(position.xz, idmg.xy); float wd = (1.0 - smoothstep(0.2, 1.7, dd)) * idmg.z * paint;\n   float nz = fract(sin(dot(floor(position * 9.0), vec3(12.99, 78.23, 37.71))) * 43758.55);\n   transformed -= objectNormal * wd * (0.07 + 0.09 * nz); }')
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
      v.body.setAttribute('idmg', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage));
      v.bodyMesh = new THREE.InstancedMesh(v.body, this.bodyMat, n);
      v.lightMesh = new THREE.InstancedMesh(v.lights, this.lightMat, n);
      if (v.glass) {
        this.glassMat = this.glassMat || makeCarGlass();
        v.glassMesh = new THREE.InstancedMesh(v.glass, this.glassMat, n); v.glassMesh.renderOrder = 2;
        v.glassMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); v.glassMesh.frustumCulled = false; v.glassMesh.count = 0; scene.add(v.glassMesh);
      }
      for (const im of [v.bodyMesh, v.lightMesh]) { im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.frustumCulled = false; im.count = 0; scene.add(im); }
      v.bodyMesh.castShadow = true;
      // Fern-Version (LOD): gleiche Lackfarbe pro Instanz, wirft keinen Schatten
      const lv = makeTrafficVariant(v.type, undefined, true);
      v.loMesh = new THREE.InstancedMesh(lv.body, this.bodyMat, n);
      v.loMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); v.loMesh.frustumCulled = false; v.loMesh.count = 0; v.loMesh.receiveShadow = true; scene.add(v.loMesh);
      v.n = 0;
    }
    const col = new THREE.Color();
    for (const vi of chosen) {
      const v = this.variants[vi];
      const car = { v, slot: v.n++, e: null, s: 0, dir: 1, lane: 0, speed: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
        state: 'drive', vx: 0, vz: 0, yawRate: 0, stopT: 0, cleared: false, waitT: 0, latOff: 0, bx: 0, bz: 0,
        pers: 0.85 + this.rng() * 0.25 };
      const p = v.type === 'truck' ? [0.9, 0.9, 0.9] : CAR_PAINTS[Math.floor(this.rng() * CAR_PAINTS.length)];
      car.paint = new THREE.Color().setRGB(p[0], p[1], p[2], THREE.SRGBColorSpace);
      v.bodyMesh.setColorAt(car.slot, car.paint); v.loMesh.setColorAt(car.slot, car.paint);
      v.lightMesh.setColorAt(car.slot, col.setRGB(1, 0, 0));
      car.idx = this.cars.length;
      car.parked = car.idx >= count;
      this.cars.push(car);
    }
    for (const c of this.cars) if (c.parked) this.placeParked(c, true);
    for (const v of this.variants) { v.bodyMesh.count = v.n; v.lightMesh.count = v.n; if (v.glassMesh) v.glassMesh.count = v.n; v.loMesh.count = 0; }
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
    const city = this.w.edges.filter((e) => e.cls === 'city' || e.cls === 'avenue');
    if (fresh || !car.spot) {
      for (let t = 0; t < 40; t++) {
        const e = city[Math.floor(this.rng() * city.length)], s = 24 + this.rng() * (e.len - 48), dir = this.rng() < 0.5 ? 1 : -1;
        if (this.cars.some((o) => o !== car && o.spot && o.spot.e === e && o.spot.dir === dir && Math.abs(o.spot.s - s) < 7)) continue;
        car.spot = { e, s, dir }; break;
      }
    }
    const sp = car.spot;
    Object.assign(car, { e: sp.e, s: sp.s, dir: sp.dir, lane: 0, speed: 0, state: 'parked', latOff: sp.e.C.halfW - 0.63 - car.v.W / 2 - sp.e.C.lanes[0], body: null, stopT: 0 });
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
      if (car.v.type === 'truck' && (e.cls === 'city' || e.cls === 'ring' || e.cls === 'park')) continue;
      const s = 10 + this.rng() * Math.max(e.len - 20, 1);
      const p = this.w.pointOnEdge(e, s, this._p);
      const d = Math.hypot(p.x - focus.x, p.z - focus.z);
      if (d < rMin || d > rMax || p.y < this.w.waterLevel - 1) continue;
      if (camera && d < 200 && this.inView(camera, p)) continue;     // nicht vor den Augen erscheinen
      const dir = e.oneWay || this.rng() < 0.5 ? 1 : -1, lane = Math.floor(this.rng() * e.C.lanes.length);
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
    const lat = car.e.C.lanes[car.lane] + car.latOff + (car.turnOff || 0);
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
    const opts = node.edges.filter((o) => o !== e && !(car.v.type === 'truck' && (o.cls === 'city' || o.cls === 'ring' || o.cls === 'park')) && !(o.oneWay && o.a !== node));
    if (!opts.length) return e;
    let tot = 0; const ws = opts.map((o) => {
      const out = o.a === node ? o.pts[1] : o.pts[o.pts.length - 2];
      const ox2 = out.x - node.x, oz2 = out.z - node.z, l = Math.hypot(ox2, oz2) || 1;
      let wgt = 0.35 + Math.max(0, (ox2 * inTx + oz2 * inTz) / l) * 2.2;
      if (car.angry > 0 && this.playerPos) { const tx = this.playerPos.x - node.x, tz = this.playerPos.z - node.z, tl = Math.hypot(tx, tz) || 1; wgt += Math.max(0, (ox2 * tx + oz2 * tz) / (l * tl)) * 6; }
      tot += wgt; return wgt;
    });
    let r = this.rng() * tot; let k = 0; while (k < ws.length - 1 && r > ws[k]) { r -= ws[k]; k++; }
    return opts[k];
  }

  update(dt, player, camera) {
    this.time = (this.time || 0) + dt; this.camPos = camera?.position; this.playerPos = player.pos;
    const w = this.w;
    for (const car of this.cars) {
      if (car.state === 'loose') { this.updateLoose(car, dt, player, camera); continue; }
      if (car.state === 'parked') continue;
      if (car.blinkT > 0 && (car.blinkT -= dt) <= 0) car.blink = 0;
      const e = car.e, C = e.C;
      const node = car.dir > 0 ? e.b : e.a;
      const toNode = car.dir > 0 ? e.len - car.s : car.s;
      let vT = C.speed[Math.min(car.lane, C.speed.length - 1)] * car.pers;
      if (car.hazard > 0) car.hazard -= dt;
      if (car.angry > 0) { car.angry -= dt; vT *= 1.4; }
      if (car.pause > 0) { car.pause -= dt; vT = 0; }
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
          const perp = axis === 'EW' ? (node.halfV || 7) : (node.halfH || 7);   // Haltelinie hinter der Querstraße
          if (st === 'R' || (st === 'Y' && toNode > 18)) stop = toNode - (perp + 4);
        } else if (node.type === 'ring') {
          // Kreisverkehr: im Kreis Vorfahrt; einfahrende Autos warten nur, wenn ein Auto im Kreis gleich vorbeikommt
          if (e.cls !== 'ring') {
            vT = Math.min(vT, 4 + toNode * 0.35);
            let busy = false;
            for (const o of this.cars) {
              if (o.state !== 'drive' || o.e.cls !== 'ring' || o.e.b !== node) continue;
              if (o.e.len - o.s < 11) { busy = true; break; }
            }
            if (busy) stop = toNode - C.stopBack;
          }
        } else if (node.type === 'hwj') {
          if (e.cls !== 'highway' && !car.cleared) {
            stop = toNode - C.stopBack;
            if (car.speed < 0.6 && stop < 2) { car.waitT += dt; if (car.waitT > 0.8 && this.highwayClear(node, player)) car.cleared = true; }
          }
        } else if (!car.cleared && !(node.type === 'tee' && e.cls !== 'park')) {   // an der Parkstraße hat die Hauptstraße Vorfahrt
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
      // Abbiegespuren vor Ampelkreuzungen: Linksabbieger ordnen sich links ein, alle anderen rechts
      { const tgt = e.cls === 'city' && node.signal && toNode < 40 && toNode > 6 ? (car.blink < 0 ? -0.7 : 2.6) : 0;
        car.turnOff = (car.turnOff || 0) + (tgt - (car.turnOff || 0)) * Math.min(1, dt * 1.3); }
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

  /** Nach leichtem Unfall auf die nächste Fahrspur zurückkehren (weiche Überblendung der Position). */
  recover(car, player) {
    const pose = this.w.nearestRoadPose(car.x, car.z, car.yaw);
    const e = pose.edge;
    if (!e || Math.hypot(pose.x - car.x, pose.z - car.z) > 8 || e.cls === 'highway' && car.v.type === 'truck' && false) return false;
    let bi = 0, bd = 1e18;
    for (let i = 0; i < e.pts.length; i++) { const p = e.pts[i], dd = (p.x - car.x) ** 2 + (p.z - car.z) ** 2; if (dd < bd) { bd = dd; bi = i; } }
    const p = e.pts[bi], fx = -Math.sin(car.yaw), fz = -Math.cos(car.yaw);
    const dir = e.oneWay ? 1 : (fx * p.tx + fz * p.tz >= 0 ? 1 : -1);
    const ox = car.x, oz = car.z, oyaw = car.yaw;
    Object.assign(car, { e, s: p.s, dir, lane: e.C.lanes.length - 1, state: 'drive', speed: 0, body: null, cleared: false, waitT: 0, stopT: 0, latOff: 0, yawRate: 0 });
    this.place(car, 0, true);
    car.bx = ox - car.x; car.bz = oz - car.z; car.x = ox; car.z = oz; car.yaw = oyaw;   // Übergang weich ausblenden
    car.hazard = 6; car.pause = 1.2;
    if (this.w.fx.length < 30) this.w.fx.push({ type: 'honk', x: car.x, y: car.y + 1, z: car.z, s: 1 });
    if (this.rng() < 0.35) car.angry = 18;                                    // verärgert: fährt dem Spieler hinterher
    return true;
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
    const upY = this._pos.set(0, 1, 0).applyQuaternion(b.quat).y;
    if (car.stopT > 0.6 && !car.wreck && (upY < 0.6 || (car.dmg || 0) > 28)) {
      // Totalschaden/überschlagen: liegen bleiben, Warnblinker, Rauch, Fahrer steigt aus
      car.wreck = true; car.wreckT = 0;
      if (this.onWreck && upY > 0.6) this.onWreck(car);
    }
    if (car.wreck) {
      car.wreckT += dt;
      if (d < 160 && Math.random() < dt * ((car.dmg || 0) > 40 ? 9 : 4) && this.w.fx.length < 30) this.w.fx.push({ type: 'smoke', x: car.x - Math.sin(car.yaw) * car.v.L * 0.35, y: car.y + car.v.H * 0.7, z: car.z - Math.cos(car.yaw) * car.v.L * 0.35, s: car.dmg });
    } else if (car.stopT > 1.6 && upY > 0.85 && !car.parked) {
      // leichter Unfall: zurück auf die Fahrspur und weiterfahren (Warnblinker, Hupe, manchmal verärgert hinterher)
      if (this.recover(car, player)) return;
    }
    if ((car.stopT > 6 && d > 60 && hidden) || (car.stopT > (car.wreck ? 60 : 25) && d > 25) || d > 700 || car.y < this.w.waterLevel - 6) {
      car.body = null; car.wreck = false; car.dmg = 0; car.dent = null;
      if (car.parked) this.placeParked(car, false); else this.respawn(car, player.pos, 110, 400, camera);
    }
  }

  writeInstances() {
    const m = this._m, q = this._q, e = this._e, p = this._pos;
    if (!this._off) this._off = this.variants.map((v) => new THREE.Matrix4().makeTranslation(0, -v.H / 2, 0));
    // LOD: Autos näher als lodDist detailliert (mit Innenraum, Glas, Felgen, Schatten), weiter weg als grobe Form
    const cp = this.camPos, lod2 = (this.lodDist || 75) ** 2;
    for (const v of this.variants) { v.hi = 0; v.lo = 0; }
    for (const car of this.cars) {
      const v = car.v, near = !cp || ((car.x - cp.x) ** 2 + (car.z - cp.z) ** 2) < lod2 || !!car.body;
      if (car.body) {
        m.compose(car.body.pos, car.body.quat, this._one).multiply(this._off[this.variants.indexOf(car.v)]);
      } else {
        e.set(car.pitch, car.yaw, 0, 'YXZ'); q.setFromEuler(e); p.set(car.x, car.y, car.z);
        m.compose(p, q, this._one);
      }
      { const on = Math.sin((this.time || 0) * Math.PI * 3) > 0, drive = car.state === 'drive';
        this._lc = this._lc || new THREE.Color();
        const haz = (car.hazard > 0 || car.wreck) && on;
        this._lc.setRGB(drive && car.brakeOn ? 3.2 : 1, (drive && car.blink < 0 && on) || haz ? 1 : 0, (drive && car.blink > 0 && on) || haz ? 1 : 0);
        car.v.lightMesh.setColorAt(car.slot, this._lc); }
      // Schaden: Lack dunkler/verrußt, Dellen (Shader), bei schweren Treffern Scheiben zersplittert (ausgeblendet)
      const dmg = car.dmg || 0, pc = dmg > 6 ? (this._pc || (this._pc = new THREE.Color())).copy(car.paint).multiplyScalar(1 - Math.min(0.45, dmg / 90)) : car.paint;
      if (near) {
        const k = v.hi++; v.bodyMesh.setMatrixAt(k, m); v.bodyMesh.setColorAt(k, pc);
        const da = v.body.attributes.idmg; if (car.dent) da.setXYZW(k, car.dent.x, car.dent.z, car.dent.a, 0); else da.setXYZW(k, 0, 0, 0, 0);
        if (v.glassMesh) v.glassMesh.setMatrixAt(k, dmg > 18 ? (this._zero || (this._zero = new THREE.Matrix4().makeScale(0, 0, 0))) : m);
      }
      else { const k = v.lo++; v.loMesh.setMatrixAt(k, m); v.loMesh.setColorAt(k, pc); }
      car.v.lightMesh.setMatrixAt(car.slot, car.state === 'parked' ? this._zero || (this._zero = new THREE.Matrix4().makeScale(0, 0, 0)) : m);
      // Kontaktschatten
      const bx = car.body ? car.body.pos.x : car.x, bz = car.body ? car.body.pos.z : car.z;
      const gy = car.body ? this.w.sample(bx, bz) : car.y;
      q.setFromAxisAngle(this._up, car.yaw);
      this._bs.set(car.v.W + 0.5, 1, car.v.L + 0.7);
      m.compose(p.set(bx, gy + 0.04, bz), q, this._bs);
      this.blobs.setMatrixAt(car.idx, m);
    }
    this.blobs.instanceMatrix.needsUpdate = true;
    for (const v of this.variants) {
      if (v.lightMesh.instanceColor) v.lightMesh.instanceColor.needsUpdate = true;
      v.bodyMesh.count = v.hi; v.loMesh.count = v.lo; if (v.glassMesh) v.glassMesh.count = v.hi;
      v.body.attributes.idmg.needsUpdate = true;
      v.loMesh.instanceMatrix.needsUpdate = true;
      if (v.bodyMesh.instanceColor) v.bodyMesh.instanceColor.needsUpdate = true;
      if (v.loMesh.instanceColor) v.loMesh.instanceColor.needsUpdate = true;
    }
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
    const P = t[3].set(x, Math.min(v.pos.y - 0.05, b.pos.y - 0.12), z);   // Stoß auf Stoßfänger-/Türhöhe (knapp unter dem Schwerpunkt → wenig Rollmoment)
    const r1 = t[4].subVectors(P, v.pos);
    const v1 = t[6].crossVectors(v.angVel, r1).add(v.vel);
    const v2 = b.pointVel(P, t[9]);
    const vn = (v1.x - v2.x) * nx + (v1.z - v2.z) * nz;
    if (vn >= 0) return;
    const lift = clamp(-vn * 0.004, 0, 0.07);   // realistischer: Stoß wirkt fast waagerecht (vorher bis 0,18 → Autos flogen meterhoch)
    const n = t[5].set(nx, -lift, nz).normalize();
    const rn = t[7].crossVectors(r1, n);
    const k1 = v.invMass + v.applyInvInertia(t[8].copy(rn)).cross(r1).dot(n);
    // getroffenes Auto: Kraft verteilt sich über Tür/Stoßfänger und Knautschzone → Angriffspunkt fast auf Schwerpunkthöhe
    // (punktförmiger Stoß 30–40 cm darunter ließ Autos mit ~8 rad/s rollen und meterhoch fliegen)
    const P2 = (this._P2 || (this._P2 = new THREE.Vector3())).set(x, b.pos.y - 0.06, z);
    const k2 = b.effInv(t[2].subVectors(P2, b.pos), n);
    const j = -(1 + 0.18) * vn / (k1 + k2);
    const J = t[8].copy(n).multiplyScalar(j);
    v.vel.addScaledVector(J, v.invMass);
    v.angVel.add(v.applyInvInertia(t[9].crossVectors(r1, J)));
    b.impulse(J.negate(), P2);
    // Schaden merken: Stärke und Aufprallpunkt im Fahrzeug-Rahmen (für Dellen, Scheiben, Liegenbleiben)
    if (-vn > 3) {
      c.dmg = (c.dmg || 0) + (-vn - 3);
      const lp = (this._lp || (this._lp = new THREE.Vector3())).subVectors(P2, b.pos).applyQuaternion((this._iq || (this._iq = new THREE.Quaternion())).copy(b.quat).invert());
      const L2 = c.v.L / 2, W2 = c.v.W / 2;
      c.dent = { x: clamp(lp.x, -W2, W2), z: clamp(lp.z, -L2, L2), a: clamp(c.dmg / 30, 0, 1) };
    }
    // Keil-Effekt: die flache Front schiebt sich bei harten Treffern unter das Auto → kann es aushebeln
    const now = performance.now();
    if (-vn > 18 && !(c.wedgeT > now)) {             // nur einmal pro Zusammenstoß, erst bei sehr harten Treffern
      c.wedgeT = now + 600;
      b.impulse(t[2].set(0, Math.min(-vn - 18, 10) * m2 * 0.03, 0), P2);
    }
    if (-vn > 2) {
      v.lastImpact = Math.max(v.lastImpact, -vn);
      if (this.w.fx.length < 30) this.w.fx.push({ type: 'spark', x, y: P.y, z, s: -vn, nx, nz });
    }
  }
}

export { TRAFFIC_TYPES, CAR_PAINTS, makeTrafficVariant, makeCarGlass, TrafficSystem };
