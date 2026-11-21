import * as THREE from 'three';
import { clamp, lerp } from '../config.js';
import { mulberry32 } from './noise.js';

// ============================== Vorstadt & Dörfer ==============================
/**
 * Übergang Stadt → Vorstadt → Land: Einfamilienhäuser mit Satteldach, Gärten und Zäunen entlang der Landstraßen
 * am Stadtrand, weiter draußen Dörfer mit Bauernhöfen (Wohnhaus + große Scheune). Wird VOR den Bäumen erzeugt,
 * damit auf den Grundstücken kein Wald wächst. Alles instanziert (wenige Draw-Calls).
 */
function genHouses(world, WORLD) {
  const rng = mulberry32(WORLD.seed + 77), C = WORLD.city, A = WORLD.air, L = WORLD.lake;
  const houses = [];
  const cityDist = (x, z) => Math.hypot(Math.max(C.x0 - x, 0, x - C.x1), Math.max(C.z0 - z, 0, z - C.z1));
  // Dorfmitten: auf langen Landstraßen weit weg von der Stadt
  const villages = [];
  for (const e of world.edges) {
    if (e.cls !== 'country' || e.len < 350 || villages.length >= 5) continue;
    const p = world.pointOnEdge(e, e.len / 2);
    if (cityDist(p.x, p.z) < 650 || villages.some((v) => Math.hypot(v.x - p.x, v.z - p.z) < 500)) continue;
    if (Math.hypot(p.x - L.cx, p.z - L.cz) < L.r + 120) continue;
    villages.push({ x: p.x, z: p.z });
  }
  const free = (x, z, r) => {
    for (const h of houses) if (Math.hypot(h.x - x, h.z - z) < r + h.r) return false;
    for (const b of world.buildingHash.at(x, z)) if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return false;
    return true;
  };
  const roadAt = (x, z) => { const i = Math.round((x + world.half) / world.cell), j = Math.round((z + world.half) / world.cell); return world.roadW[j * world.n + i] || 0; };
  for (const e of world.edges) {
    if (e.cls !== 'country') continue;
    for (let s = 20; s < e.len - 20; s += 20 + rng() * 10) {
      const p = world.pointOnEdge(e, s), cd = cityDist(p.x, p.z);
      const vil = villages.find((v) => Math.hypot(v.x - p.x, v.z - p.z) < 170);
      const suburb = cd > 25 && cd < 380;
      if (!suburb && !vil) continue;
      for (const side of [-1, 1]) {
        if (rng() > (suburb ? 0.8 : 0.7)) continue;
        const farm = !!vil && rng() < 0.3;
        const off = farm ? 26 : 16;
        const rx = -p.tz * side, rz = p.tx * side;
        const x = p.x + rx * off, z = p.z + rz * off, r = farm ? 16 : 10;
        if (Math.abs(x - A.cx) < A.hx + 60 && Math.abs(z - A.cz) < A.hz + 80) continue;
        if (Math.hypot(x - L.cx, z - L.cz) < L.r + 25) continue;
        const y = world.sample(x, z);
        if (y < world.waterLevel + 1.5) continue;
        let ok = true, ymin = y, ymax = y;
        for (const [a, b] of [[-r, -r], [r, -r], [-r, r], [r, r], [0, 0]]) {
          const yy = world.sample(x + a, z + b); ymin = Math.min(ymin, yy); ymax = Math.max(ymax, yy);

        }
        // keine andere Straße auf dem Grundstück (Mitte und straßenabgewandte Seite prüfen)
        if (roadAt(x, z) > 0.35 || roadAt(x + rx * r, z + rz * r) > 0.35) ok = false;
        if (!ok || ymax - ymin > 4.5 || !free(x, z, r)) continue;
        const yaw = Math.atan2(rx, rz);                    // Vorderseite zur Straße
        if (farm) {
          houses.push({ kind: 'farmhouse', x: x - p.tx * 7, z: z - p.tz * 7, y: ymin, yaw, w: 11, d: 9, h: 6.5, roof: 4.5, tint: rng(), r: 8 });
          houses.push({ kind: 'barn', x: x + p.tx * 11 + rx * 4, z: z + p.tz * 11 + rz * 4, y: ymin, yaw: yaw + Math.PI / 2, w: 12, d: 20, h: 6, roof: 5.5, tint: rng(), r: 11 });
        } else {
          const w = 8 + rng() * 3, d = 7 + rng() * 2;
          houses.push({ kind: 'house', x, z, y: ymin, yaw, w, d, h: rng() < 0.3 ? 3.3 : 6, roof: 2.6 + rng() * 1.4, tint: rng(), r, garden: rng() < 0.85, hedge: rng() < 0.4 });
        }
      }
    }
  }
  // Kollision: verkleinerte, achsparallele Hülle (Häuser sind gedreht)
  for (const h of houses) {
    const ex = (Math.abs(Math.cos(h.yaw)) * h.w + Math.abs(Math.sin(h.yaw)) * h.d) * 0.4, ez = (Math.abs(Math.sin(h.yaw)) * h.w + Math.abs(Math.cos(h.yaw)) * h.d) * 0.4;
    const b = { x0: h.x - ex, x1: h.x + ex, z0: h.z - ez, z1: h.z + ez, y0: h.y, top: h.y + h.h, h: h.h, kind: 9, tint: 0, house: true };
    world.buildingHash.insert(b.x0, b.z0, b.x1, b.z1, b);
  }
  world.houses = houses; world.villages = villages;
  world.houseHash = new Map();
  for (const h of houses) { const k = Math.floor(h.x / 40) + ',' + Math.floor(h.z / 40); if (!world.houseHash.has(k)) world.houseHash.set(k, []); world.houseHash.get(k).push(h); }
}

/** Liegt (x, z) auf einem Haus-/Gartengrundstück? (für die Baum-Platzierung) */
function onHousePlot(world, x, z) {
  if (!world.houseHash) return false;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const l = world.houseHash.get((Math.floor(x / 40) + a) + ',' + (Math.floor(z / 40) + b));
    if (l) for (const h of l) if (Math.hypot(h.x - x, h.z - z) < h.r + 6) return true;
  }
  return false;
}

/** Fassade eines Einfamilienhauses: Putz, Sprossenfenster mit Fensterläden, Haustür (Kachel = eine Hausseite). */
function houseTexture(kind) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256; const c = cv.getContext('2d'), rng = mulberry32(kind === 'barn' ? 5 : 9);
  if (kind === 'barn') {
    c.fillStyle = '#8a4a2e'; c.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 256; x += 10) { c.fillStyle = `rgba(0,0,0,${0.15 + rng() * 0.15})`; c.fillRect(x, 0, 2, 256); }      // Holzbretter
    c.fillStyle = '#5a2e1c'; c.fillRect(78, 96, 100, 160); c.strokeStyle = '#d8c9a8'; c.lineWidth = 5; c.strokeRect(78, 96, 100, 160);
    c.beginPath(); c.moveTo(78, 96); c.lineTo(178, 256); c.moveTo(178, 96); c.lineTo(78, 256); c.stroke();                   // Scheunentor
  } else {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, 256, 256);
    const img = c.getImageData(0, 0, 256, 256), d = img.data; for (let i = 0; i < d.length; i += 4) { const nn = (rng() - 0.5) * 18; d[i] += nn; d[i + 1] += nn; d[i + 2] += nn; } c.putImageData(img, 0, 0);
    c.fillStyle = '#c9c3b8'; c.fillRect(0, 232, 256, 24);                                                                  // Sockel
    const win = (x, y, w, h) => {
      c.fillStyle = '#3a5a40'; c.fillRect(x - 12, y, 10, h); c.fillRect(x + w + 2, y, 10, h);                              // Fensterläden
      c.fillStyle = '#f2f2ee'; c.fillRect(x - 3, y - 3, w + 6, h + 6);
      c.fillStyle = '#26313a'; c.fillRect(x, y, w, h);
      c.fillStyle = '#f2f2ee'; c.fillRect(x + w / 2 - 1.5, y, 3, h); c.fillRect(x, y + h * 0.42, w, 3);
      c.fillStyle = 'rgba(160,200,230,0.25)'; c.fillRect(x, y, w / 2, h * 0.4);
    };
    win(36, 40, 44, 56); win(176, 40, 44, 56);                       // Obergeschoss
    win(36, 150, 44, 56); win(176, 150, 44, 56);                     // Erdgeschoss
    c.fillStyle = '#5b3a24'; c.fillRect(110, 140, 36, 92); c.fillStyle = '#d4b26a'; c.fillRect(138, 186, 4, 4);   // Haustür
    c.fillStyle = '#e9e4da'; c.fillRect(104, 134, 48, 6);
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Häuser, Dächer, Kamine, Zäune und Hecken als instanzierte Meshes erzeugen. */
function buildHouses(world, group, q) {
  const H = world.houses || [];
  if (!H.length) return;
  const m = new THREE.Matrix4(), qt = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
  const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mk = (geo, mat, n, shadow = true) => { const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n)); im.castShadow = shadow && q.shadows; im.receiveShadow = true; im.frustumCulled = false; im.count = 0; group.add(im); return im; };
  const wallsH = mk(unit, new THREE.MeshStandardMaterial({ map: houseTexture('house'), roughness: 0.85 }), H.length);
  const wallsB = mk(unit, new THREE.MeshStandardMaterial({ map: houseTexture('barn'), roughness: 0.9 }), H.length);
  // Satteldach als Prisma mit Dachüberstand
  const sh = new THREE.Shape(); sh.moveTo(-0.5, 0); sh.lineTo(0, 1); sh.lineTo(0.5, 0); sh.lineTo(-0.5, 0);
  const roofGeo = new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
  const roofs = mk(roofGeo, new THREE.MeshStandardMaterial({ roughness: 0.75 }), H.length);
  const chim = mk(unit, new THREE.MeshStandardMaterial({ color: 0x7a3b2a, roughness: 0.9 }), H.length);
  const fence = mk(unit, new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.8 }), H.length * 4, false);
  const hedge = mk(unit, new THREE.MeshStandardMaterial({ color: 0x2f5a24, roughness: 1 }), H.length * 3);
  const lawn = mk(unit, new THREE.MeshStandardMaterial({ color: 0x5a8a34, roughness: 1 }), H.length, false);
  const plaster = [[0.97, 0.95, 0.9], [0.95, 0.88, 0.72], [0.9, 0.82, 0.78], [0.86, 0.9, 0.88], [0.98, 0.98, 0.98], [0.92, 0.86, 0.7]];
  let nw = 0, nb = 0, nr = 0, nc = 0, nf = 0, nh = 0, nl = 0;
  const place = (im, k, lx, ly, lz, sx, sy, sz, h, extraYaw = 0) => {
    const c = Math.cos(h.yaw), sn = Math.sin(h.yaw);
    qt.setFromAxisAngle(up, h.yaw + extraYaw);
    m.compose(v.set(h.x + lx * c + lz * sn, h.y + ly, h.z - lx * sn + lz * c), qt, s.set(sx, sy, sz));
    im.setMatrixAt(k, m);
  };
  for (const h of H) {
    if (h.kind === 'barn') { place(wallsB, nb++, 0, -0.3, 0, h.w, h.h + 0.3, h.d, h); }
    else {
      place(wallsH, nw, 0, -0.3, 0, h.w, h.h + 0.3, h.d, h);
      const p = plaster[Math.floor(h.tint * plaster.length)]; wallsH.setColorAt(nw++, col.setRGB(p[0], p[1], p[2], THREE.SRGBColorSpace));
    }
    // Dach: First parallel zur Straße (über die Breite w), Überstand 0,6 m
    // Prisma liegt mit dem First entlang z → um 90° drehen und Breite/Tiefe tauschen
    { const c = Math.cos(h.yaw), sn = Math.sin(h.yaw); qt.setFromAxisAngle(up, h.yaw + Math.PI / 2); m.compose(v.set(h.x, h.y + h.h, h.z), qt, s.set(h.d + 1.2, h.roof, h.w + 0.8)); roofs.setMatrixAt(nr, m); void c; void sn; }
    roofs.setColorAt(nr++, h.kind === 'barn' ? col.setRGB(0.32, 0.3, 0.3, THREE.SRGBColorSpace) : h.tint < 0.6 ? col.setRGB(0.6 + h.tint * 0.2, 0.25, 0.16, THREE.SRGBColorSpace) : col.setRGB(0.24, 0.25, 0.28, THREE.SRGBColorSpace));
    if (h.kind !== 'barn') place(chim, nc++, h.w * 0.25, h.h + h.roof * 0.55, -h.d * 0.15, 0.6, h.roof * 0.75, 0.6, h);
    if (h.garden) {
      // Garten hinter dem Haus: Rasenfläche, Zaun (Latten) oder Hecke an drei Seiten
      const gd = 14, gw = h.w + 6, z0 = h.d / 2, z1 = z0 + gd;   // lokales +z zeigt von der Straße weg → Garten hinter dem Haus
      place(lawn, nl++, 0, 0.02, (z0 + z1) / 2, gw, 0.06, gd, h);
      const seg = [[0, z1, gw, 0.08], [-gw / 2, (z0 + z1) / 2, 0.08, gd], [gw / 2, (z0 + z1) / 2, 0.08, gd]];
      for (const [lx, lz, sx, sz] of seg) {
        if (h.hedge) place(hedge, nh++, lx, 0, lz, Math.max(sx, 0.8), 1.4, Math.max(sz, 0.8), h);
        else place(fence, nf++, lx, 0, lz, sx, 1.0, sz, h);
      }
      // Vorgartenzaun zur Straße
      if (!h.hedge) place(fence, nf++, 0, 0, -(h.d / 2 + 3), gw, 0.8, 0.08, h);
    }
  }
  wallsH.count = nw; wallsB.count = nb; roofs.count = nr; chim.count = nc; fence.count = nf; hedge.count = nh; lawn.count = nl;
  for (const im of [wallsH, wallsB, roofs, chim, fence, hedge, lawn]) { im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
}

export { genHouses, buildHouses, onHousePlot };
