import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../config.js';
import { mulberry32, hash2, vnoise, fbm, ridged, tick } from './noise.js';
import { makeWedge, makeNoiseTexture } from '../environment.js';

// ============================== Welt-Konstanten ==============================
const WORLD = {
  half: 2000, cell: 4, n: 1001, seed: 20261117, waterLevel: 2, bound: 1930,
  city: { x0: 300, z0: 150, lines: 8, spacing: 100, h: 22, streetHalf: 7 },
  air: { cx: 300, cz: -1000, hx: 860, hz: 75, h: 14 },
  lake: { cx: -700, cz: 650, r: 330 },
};
WORLD.city.x1 = WORLD.city.x0 + (WORLD.city.lines - 1) * WORLD.city.spacing;
WORLD.city.z1 = WORLD.city.z0 + (WORLD.city.lines - 1) * WORLD.city.spacing;
WORLD.city.cx = (WORLD.city.x0 + WORLD.city.x1) / 2;
WORLD.city.cz = (WORLD.city.z0 + WORLD.city.z1) / 2;

/** Straßenklassen: halbe Breite, Fahrspur-Mitten (vom Mittelstreifen nach rechts), Tempo, Steigung. */
const ROAD_CLASS = {
  highway: { halfW: 11, lanes: [2.7, 6.3], speed: [35, 28], grade: 0.05, smooth: 30, stopBack: 6 },
  country: { halfW: 4.2, lanes: [2.0], speed: [22], grade: 0.10, smooth: 10, stopBack: 6 },
  city:    { halfW: 7, lanes: [2.4], speed: [13.5], grade: 0, smooth: 0, stopBack: 11 },
};
// Untergrund: 0 Gras, 1 Asphalt, 2 Waldboden, 3 Sand, 4 Fels
const SURF_GRIP = [0.78, 1.0, 0.72, 0.6, 0.86];
const SURF_ROLL = [2.4, 1.0, 2.8, 4.5, 1.4];

/** Einfaches räumliches Raster für schnelle Nachbarschafts-Abfragen. */
class SpatialHash {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  _k(i, j) { return (i + 4096) * 16384 + (j + 4096); }
  insert(minX, minZ, maxX, maxZ, item) {
    const c = this.cell;
    for (let i = Math.floor(minX / c); i <= Math.floor(maxX / c); i++) {
      for (let j = Math.floor(minZ / c); j <= Math.floor(maxZ / c); j++) {
        const k = this._k(i, j); let a = this.map.get(k);
        if (!a) this.map.set(k, a = []);
        a.push(item);
      }
    }
  }
  at(x, z) { return this.map.get(this._k(Math.floor(x / this.cell), Math.floor(z / this.cell))) || EMPTY_ARR; }
  /** Alle Einträge in Zellen um (x,z) im Radius r (Duplikate möglich). */
  near(x, z, r, cb) {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        const a = this.map.get(this._k(i, j));
        if (a) for (let k = 0; k < a.length; k++) cb(a[k]);
      }
    }
  }
}
const EMPTY_ARR = [];

/** Rechteck-Maske mit weichem Rand (1 innen, 0 außen). */
function rectMask(x, z, cx, cz, hx, hz, blend) {
  const dx = Math.max(Math.abs(x - cx) - hx, 0), dz = Math.max(Math.abs(z - cz) - hz, 0);
  return 1 - smoothstep(0, blend, Math.hypot(dx, dz));
}

/** Spline durch Kontrollpunkte, gleichmäßig in ~spacing Meter abgetastet. */
function splinePoints(ctrl, closed, spacing = 4) {
  const curve = new THREE.CatmullRomCurve3(ctrl.map((p) => new THREE.Vector3(p[0], 0, p[1])), closed, 'centripetal');
  const n = Math.max(2, Math.round(curve.getLength() / spacing));
  const pts = curve.getSpacedPoints(n).map((v) => ({ x: v.x, z: v.z }));
  if (closed) pts.pop();
  return pts;
}

/** Mehrere Teil-Geometrien mit Farben zu einer Geometrie zusammenfassen (1 Draw-Call). */
function mergeParts(parts) {
  const list = []; let count = 0;
  for (const p of parts) {
    let g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.m) g.applyMatrix4(p.m);
    if (!g.attributes.normal) g.computeVertexNormals();
    list.push([g, p.color]); count += g.attributes.position.count;
  }
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), col = new Float32Array(count * 3);
  let o = 0; const c = new THREE.Color();
  for (const [g, color] of list) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    const vc = g.attributes.color;
    if (!vc) c.setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace);
    for (let i = 0; i < n; i++) {
      const k = (o + i) * 3;
      if (vc) { col[k] = vc.getX(i); col[k + 1] = vc.getY(i); col[k + 2] = vc.getZ(i); }
      else { col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b; }
    }
    o += n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/** Eckpunkte zufällig verschieben (organischere Formen). */
function jitter(geo, amt, rng) {
  const p = geo.attributes.position;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = seen.get(key);
    if (!d) { d = [(rng() - 0.5) * amt, (rng() - 0.5) * amt * 0.6, (rng() - 0.5) * amt]; seen.set(key, d); }
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Vertexfarben als Verlauf über die Höhe (sRGB-Farben a → b). */
function gradientColors(geo, a, b, y0, y1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const ca = new THREE.Color().setRGB(a[0], a[1], a[2], THREE.SRGBColorSpace);
  const cb = new THREE.Color().setRGB(b[0], b[1], b[2], THREE.SRGBColorSpace);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    c.copy(ca).lerp(cb, clamp((p.getY(i) - y0) / (y1 - y0), 0, 1));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// ============================== World ==============================
/**
 * Offene Welt (4 × 4 km):
 *  - Höhenfeld im 4-m-Raster (Gelände + eingeprägte Straßen), bilinear abgefragt
 *  - Straßennetz als Graph (Autobahnring, Landstraßen, Stadtraster)
 *  - Stadt mit Gebäuden, Ampeln, Laternen; Wald; See mit Brücke; Flugplatz mit Rampen
 *  - Kollisionen: Gelände, Brücke, Dächer, Gebäudewände, Leitplanken
 */
class World {
  constructor(q) {
    this.q = q;
    this.n = WORLD.n; this.cell = WORLD.cell; this.half = WORLD.half;
    this.bound = WORLD.bound; this.waterLevel = WORLD.waterLevel;
    this.nodes = []; this.edges = [];
    this.buildings = []; this.buildingHash = new SpatialHash(50);
    this.barrierHash = new SpatialHash(40);
    this.bridgeHash = new SpatialHash(40);
    this.roadPointHash = new SpatialHash(60);
    this.lamps = []; this.lampHash = new SpatialHash(80);
    this.signals = [];
    this.ramps = [];
    this.time = 0;
    this._stamp = 1;
    this.fx = [];               // Effekt-Ereignisse (Funken, Baum …) für Partikel und Ton
  }

  // ---------------------------------------------------------------- Erzeugung
  async generate(progress) {
    progress(0.05, 'Gelände formen …'); await tick();
    this.genTerrain();
    progress(0.25, 'Straßen planen …'); await tick();
    this.genRoads();
    progress(0.4, 'Straßen ins Gelände einbauen …'); await tick();
    this.rasterRoads();
    progress(0.52, 'Boden einfärben …'); await tick();
    this.genColors();
    progress(0.62, 'Stadt bauen …'); await tick();
    this.genCity();
    progress(0.7, 'Wald pflanzen …'); await tick();
    this.genTrees();
    this.genRamps();
    this.treeHash = new SpatialHash(16);
    for (let i = 0; i < this.trees.count; i++) this.treeHash.insert(this.trees.x[i], this.trees.z[i], this.trees.x[i], this.trees.z[i], i);
  }

  /** Großräumiges Gelände: Hügel, Bergkämme, See-Becken, Randgebirge, flache Stadt/Flugplatz. */
  genTerrain() {
    const { n, cell, half } = this;
    const WL = this.waterLevel, L = WORLD.lake, C = WORLD.city, A = WORLD.air;
    // 1) Grobe Formen auf 16-m-Raster (schnell), danach fein interpoliert
    const cs = 4, cn = Math.ceil((n - 1) / cs) + 1;
    const coarse = new Float32Array(cn * cn);
    for (let j = 0; j < cn; j++) {
      for (let i = 0; i < cn; i++) {
        const x = -half + i * cs * cell, z = -half + j * cs * cell;
        let h = 16 + fbm(x * 0.0011, z * 0.0011, 5, 1) * 40;
        const mm = smoothstep(0.45, 0.72, fbm(x * 0.0005 + 7.3, z * 0.0005 - 2.1, 3, 5) * 0.5 + 0.5);
        h += Math.pow(ridged(x * 0.0024, z * 0.0024, 4, 9), 2) * 75 * mm;
        const edge = Math.max(Math.abs(x), Math.abs(z));
        h += Math.pow(smoothstep(1480, 1990, edge), 1.6) * 175;           // Randgebirge
        // See-Becken mit unregelmäßigem Ufer
        const dx = x - L.cx, dz = z - L.cz, d = Math.hypot(dx, dz), ang = Math.atan2(dz, dx);
        const rr = L.r * (1 + 0.16 * Math.sin(ang * 3 + 1) + 0.09 * Math.sin(ang * 5 + 2));
        h = lerp(h, Math.min(h, WL + 8), smoothstep(rr * 2.4, rr * 1.05, d) * 0.9);
        // außerhalb des Sees keine Senken unter Wasserhöhe (sonst „trockene Pfützen“)
        h = Math.max(h, lerp(WL + 6, -100, smoothstep(rr * 1.6, rr * 1.1, d)));
        h = lerp(h, WL - 3 - 8 * smoothstep(rr * 0.85, 0, d), smoothstep(rr * 1.02, rr * 0.78, d));
        coarse[j * cn + i] = h;
      }
    }
    const H0 = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const gj = j / cs, j0 = Math.min(Math.floor(gj), cn - 2), fz = gj - j0;
      for (let i = 0; i < n; i++) {
        const gi = i / cs, i0 = Math.min(Math.floor(gi), cn - 2), fx = gi - i0;
        const k = j0 * cn + i0;
        let h = (coarse[k] * (1 - fx) + coarse[k + 1] * fx) * (1 - fz) + (coarse[k + cn] * (1 - fx) + coarse[k + cn + 1] * fx) * fz;
        const x = -half + i * cell, z = -half + j * cell;
        h += fbm(x * 0.009, z * 0.009, 2, 3) * 2.2;                         // Feinstruktur
        // Flache Bereiche: Stadt und Flugplatz
        h = lerp(h, C.h, rectMask(x, z, C.cx, C.cz, (C.x1 - C.x0) / 2 + 30, (C.z1 - C.z0) / 2 + 30, 170));
        h = lerp(h, A.h, rectMask(x, z, A.cx, A.cz, A.hx + 40, A.hz + 60, 160));
        H0[j * n + i] = h;
      }
    }
    this.H0 = H0;
  }

  /** Bilineare Abfrage eines Rasters. */
  gridAt(G, x, z) {
    const { n, cell, half } = this;
    const gx = clamp((x + half) / cell, 0, n - 1.001), gz = clamp((z + half) / cell, 0, n - 1.001);
    const i = gx | 0, j = gz | 0, fx = gx - i, fz = gz - j, k = j * n + i;
    return (G[k] * (1 - fx) + G[k + 1] * fx) * (1 - fz) + (G[k + n] * (1 - fx) + G[k + n + 1] * fx) * fz;
  }

  addNode(x, z, type) {
    const nd = { id: this.nodes.length, x, z, y: 0, edges: [], type, signal: false, phase: 0 };
    this.nodes.push(nd); return nd;
  }

  /** Kante mit gleichmäßig abgetasteten Punkten (inkl. Höhe y) anlegen. */
  addEdge(a, b, pts, cls) {
    const e = { id: this.edges.length, a, b, cls, C: ROAD_CLASS[cls], pts, len: 0, sp: 4 };
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      p.s = s;
      const q0 = pts[Math.max(i - 1, 0)], q1 = pts[Math.min(i + 1, pts.length - 1)];
      const tl = Math.hypot(q1.x - q0.x, q1.z - q0.z) || 1;
      p.tx = (q1.x - q0.x) / tl; p.tz = (q1.z - q0.z) / tl;
    }
    e.len = s; e.sp = s / (pts.length - 1);
    a.edges.push(e); b.edges.push(e); this.edges.push(e);
    for (let i = 0; i < pts.length; i += 2) this.roadPointHash.insert(pts[i].x, pts[i].z, pts[i].x, pts[i].z, { e, i });
    return e;
  }

  /** Höhenverlauf einer Straße: geglättetes Gelände, Steigung begrenzt, Enden angeheftet. */
  profile(pts, C, closed, yA, yB, minY) {
    const n = pts.length;
    let y = pts.map((p) => Math.max(this.gridAt(this.H0, p.x, p.z), minY ?? -1e9));
    const r = C.smooth;
    for (let pass = 0; pass < 3 && r > 0; pass++) {
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let k = -r; k <= r; k++) {
          let idx = i + k;
          if (closed) idx = (idx + n) % n; else if (idx < 0 || idx >= n) continue;
          s += y[idx]; c++;
        }
        out[i] = s / c;
      }
      y = out;
    }
    // Enden an Knotenhöhen anheften (weich über bis zu 200 m)
    if (!closed) {
      const Lb = Math.min(200, (n - 1) * 2);
      const d0 = yA !== undefined ? yA - y[0] : 0, d1 = yB !== undefined ? yB - y[n - 1] : 0;
      for (let i = 0; i < n; i++) {
        const s = i * 4, e = (n - 1 - i) * 4;
        y[i] += d0 * (1 - smoothstep(0, Lb, s)) + d1 * (1 - smoothstep(0, Lb, e));
      }
    }
    // Steigung begrenzen (vor- und rückwärts)
    const g = C.grade * 4;
    for (let rep = 0; rep < (closed ? 2 : 1); rep++) {
      for (let i = 1; i < n; i++) y[i] = clamp(y[i], y[i - 1] - g, y[i - 1] + g);
      for (let i = n - 2; i >= 0; i--) y[i] = clamp(y[i], y[i + 1] - g, y[i + 1] + g);
    }
    if (!closed) { if (yA !== undefined) y[0] = yA; if (yB !== undefined) y[n - 1] = yB; }
    for (let i = 0; i < n; i++) pts[i].y = y[i];
  }

  /** Straßennetz: Autobahnring mit Seebrücke, Landstraßen, Stadtraster. */
  genRoads() {
    const C = WORLD.city;
    // --- Stadtraster ---
    const grid = [];
    for (let i = 0; i < C.lines; i++) {
      grid[i] = [];
      for (let j = 0; j < C.lines; j++) {
        const nd = this.addNode(C.x0 + i * C.spacing, C.z0 + j * C.spacing, 'city');
        nd.y = C.h; nd.gi = i; nd.gj = j; grid[i][j] = nd;
      }
    }
    const line = (a, b) => {
      const pts = [], L = Math.hypot(b.x - a.x, b.z - a.z), m = Math.round(L / 4);
      for (let k = 0; k <= m; k++) pts.push({ x: lerp(a.x, b.x, k / m), z: lerp(a.z, b.z, k / m), y: C.h });
      return pts;
    };
    for (let i = 0; i < C.lines; i++) {
      for (let j = 0; j < C.lines; j++) {
        if (i + 1 < C.lines) this.addEdge(grid[i][j], grid[i + 1][j], line(grid[i][j], grid[i + 1][j]), 'city');
        if (j + 1 < C.lines) this.addEdge(grid[i][j], grid[i][j + 1], line(grid[i][j], grid[i][j + 1]), 'city');
      }
    }
    this.cityGrid = grid;

    // --- Autobahnring (geschlossen), führt über den See ---
    const HW = [[-1300, -1250], [0, -1400], [1250, -1350], [1450, -200], [1420, 1050], [850, 1400], [0, 1350],
                [-700, 1150], [-640, 650], [-850, 100], [-1400, -350]];
    const hw = splinePoints(HW, true, 4);
    this.profile(hw, ROAD_CLASS.highway, true, undefined, undefined, this.waterLevel + 8);
    // Anschlussstellen (Landstraßen treffen den Ring)
    const nearestIdx = (x, z) => { let best = 0, bd = 1e18; hw.forEach((p, i) => { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; best = i; } }); return best; };
    const J = {
      east: nearestIdx(1440, 420), north: nearestIdx(-500, -1330), lakeS: nearestIdx(-480, 1210),
      west: nearestIdx(-1390, -450), south: nearestIdx(780, 1390),
    };
    const idxs = Object.values(J).sort((a, b) => a - b);
    const jNodes = {};
    for (const [name, idx] of Object.entries(J)) {
      const p = hw[idx]; const nd = this.addNode(p.x, p.z, 'hwj'); nd.y = p.y; nd.hwIdx = idx; jNodes[name] = nd;
    }
    const nodeAt = (idx) => Object.values(jNodes).find((nd) => nd.hwIdx === idx);
    for (let k = 0; k < idxs.length; k++) {
      const i0 = idxs[k], i1 = idxs[(k + 1) % idxs.length];
      const pts = [];
      for (let i = i0; ; i = (i + 1) % hw.length) { pts.push({ ...hw[i] }); if (i === i1) break; }
      this.addEdge(nodeAt(i0), nodeAt(i1), pts, 'highway');
    }
    // Brückenabschnitte erkennen (Straße hoch über Wasser)
    for (const e of this.edges) {
      if (e.cls !== 'highway') continue;
      const flags = e.pts.map((p) => this.gridAt(this.H0, p.x, p.z) < this.waterLevel + 0.5 && p.y - this.gridAt(this.H0, p.x, p.z) > 3);
      for (let i = 0; i < e.pts.length; i++) {
        let f = false;
        for (let k = -5; k <= 5; k++) if (flags[i + k]) f = true;
        e.pts[i].bridge = f;
      }
    }

    // --- Landstraßen ---
    const country = (from, ctrl, to) => {
      const pts = splinePoints([[from.x, from.z], ...ctrl, [to.x, to.z]], false, 4);
      pts[0].x = from.x; pts[0].z = from.z; pts[pts.length - 1].x = to.x; pts[pts.length - 1].z = to.z;
      this.profile(pts, ROAD_CLASS.country, false, from.y, to.y, this.waterLevel + 1.5);
      return this.addEdge(from, to, pts, 'country');
    };
    const lakeJ = this.addNode(-50, 600, 'junction');
    lakeJ.y = lerp(this.gridAt(this.H0, -50, 600), C.h, 0.3);
    country(grid[7][3], [[1150, 470], [1300, 430]], jNodes.east);
    country(grid[2][0], [[470, -100], [380, -400], [320, -700], [250, -905], [-100, -940], [-400, -1100]], jNodes.north);
    country(grid[0][3], [[150, 470], [40, 560]], lakeJ);
    country(lakeJ, [[-150, 800], [-300, 1000], [-420, 1150]], jNodes.lakeS);
    country(lakeJ, [[-150, 300], [-300, 0], [-500, -250], [-800, -450], [-1100, -500]], jNodes.west);
    country(grid[4][7], [[720, 1000], [760, 1200]], jNodes.south);

    // Ampeln an Stadtkreuzungen (mind. 3 Straßen)
    for (const nd of this.nodes) {
      if (nd.type === 'city' && nd.edges.length >= 3) { nd.signal = true; nd.phase = ((nd.gi + nd.gj) * 3.1) % 30; }
    }
  }

  /** Straßen ins Gelände prägen: Einschnitte und Dämme entstehen automatisch. */
  rasterRoads() {
    const { n, cell, half, H0 } = this;
    const sumW = new Float32Array(n * n), sumWH = new Float32Array(n * n), maxW = new Float32Array(n * n);
    const surf = new Uint8Array(n * n);
    for (const e of this.edges) {
      if (e.cls === 'city') continue;
      const hw = e.C.halfW;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const p = e.pts[i], q = e.pts[i + 1];
        if (p.bridge && q.bridge) continue;
        const dh = Math.abs(p.y - this.gridAt(H0, p.x, p.z));
        const fall = clamp(7 + dh * 1.7, 7, 42), R = hw + 1 + fall;
        const dx = q.x - p.x, dz = q.z - p.z, len2 = dx * dx + dz * dz || 1;
        const i0 = Math.max(0, Math.floor((Math.min(p.x, q.x) - R + half) / cell)), i1 = Math.min(n - 1, Math.ceil((Math.max(p.x, q.x) + R + half) / cell));
        const j0 = Math.max(0, Math.floor((Math.min(p.z, q.z) - R + half) / cell)), j1 = Math.min(n - 1, Math.ceil((Math.max(p.z, q.z) + R + half) / cell));
        for (let j = j0; j <= j1; j++) {
          const wz = -half + j * cell;
          for (let ii = i0; ii <= i1; ii++) {
            const wx = -half + ii * cell;
            const t = clamp(((wx - p.x) * dx + (wz - p.z) * dz) / len2, 0, 1);
            const d = Math.hypot(wx - p.x - dx * t, wz - p.z - dz * t);
            if (d > R) continue;
            const w = d <= hw + 1 ? 1 : 1 - smoothstep(hw + 1, R, d);
            const k = j * n + ii, w2 = w * w;
            if (w > maxW[k]) maxW[k] = w;
            sumW[k] += w2; sumWH[k] += w2 * (p.y + (q.y - p.y) * t);
            if (d < hw + 0.8) surf[k] = 1;
          }
        }
      }
    }
    const H = new Float32Array(n * n);
    for (let k = 0; k < n * n; k++) H[k] = maxW[k] > 0 ? lerp(H0[k], sumWH[k] / sumW[k], maxW[k]) : H0[k];
    // Stadt und Startbahn sind befestigt
    const C = WORLD.city, A = WORLD.air;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = -half + i * cell, z = -half + j * cell;
      if (x > C.x0 - 12 && x < C.x1 + 12 && z > C.z0 - 12 && z < C.z1 + 12) surf[j * n + i] = 1;
      if (Math.abs(x - A.cx) < A.hx && Math.abs(z - A.cz) < 32) surf[j * n + i] = 1;
    }
    this.H = H; this.roadW = maxW; this.surf = surf;
    this.H0 = null;           // wird nicht mehr gebraucht (Speicher sparen)
  }

  forestDensity(x, z) {
    let d = smoothstep(0.5, 0.64, fbm(x * 0.0018 + 3, z * 0.0018 - 5, 4, 21) * 0.5 + 0.5);
    d = Math.min(1, d + (x < -150 ? 0.18 : 0) * smoothstep(0.3, 0.5, fbm(x * 0.003, z * 0.003, 2, 4) * 0.5 + 0.5));
    return d;
  }

  slopeAt(i, j) {
    const n = this.n, H = this.H;
    const a = H[j * n + Math.max(i - 1, 0)], b = H[j * n + Math.min(i + 1, n - 1)];
    const c = H[Math.max(j - 1, 0) * n + i], d = H[Math.min(j + 1, n - 1) * n + i];
    return Math.hypot(b - a, d - c) / (2 * this.cell);
  }

  /** Bodenfarben (sRGB, 8 Bit) + Untergrundart pro Rasterzelle. */
  genColors() {
    const { n, cell, half, H, surf, roadW } = this;
    const col = new Uint8Array(n * n * 3);
    const WL = this.waterLevel, C = WORLD.city, A = WORLD.air;
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const LUSH = [62, 104, 34], DRY = [132, 124, 62], FOREST = [46, 66, 28], ROCK = [112, 106, 98], SNOW = [232, 236, 240],
      SAND = [178, 160, 118], WET = [96, 88, 64], GRAVEL = [112, 104, 88], ASPH = [86, 82, 70], CITY = [88, 88, 90], MOWN = [88, 118, 50];
    this.forestD = new Uint8Array(n * n);
    const splat = this.splat = new Uint8Array(n * n * 4);   // Gras, Waldboden/Erde, Fels, Sand
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i, x = -half + i * cell, z = -half + j * cell, h = H[k];
        const s = this.slopeAt(i, j);
        const fn = fbm(x * 0.006, z * 0.006, 3, 11) * 0.5 + 0.5;
        let c = mix(LUSH, DRY, smoothstep(0.55, 0.85, fn) * 0.75);
        const fd = this.forestDensity(x, z) * (1 - smoothstep(95, 130, h));
        this.forestD[k] = fd * 255;
        c = mix(c, FOREST, fd * 0.8);
        const rock = smoothstep(0.5, 0.95, s + (fbm(x * 0.02, z * 0.02, 2, 7)) * 0.15);
        c = mix(c, ROCK, rock);
        c = mix(c, SNOW, smoothstep(115, 160, h) * (1 - smoothstep(0.7, 1.1, s)));
        const sand = smoothstep(WL + 3.2, WL + 1.0, h);
        c = mix(c, SAND, sand);
        if (h < WL) c = mix(SAND, WET, smoothstep(WL, WL - 3, h));
        c = mix(c, GRAVEL, smoothstep(0.55, 0.95, roadW[k]) * 0.5);
        let su = surf[k];
        if (su === 1) c = ASPH;
        if (x > C.x0 - 14 && x < C.x1 + 14 && z > C.z0 - 14 && z < C.z1 + 14) c = CITY;
        else if (Math.abs(x - A.cx) < A.hx + 30 && Math.abs(z - A.cz) < A.hz + 40 && su !== 1) c = MOWN;
        if (su !== 1) su = rock > 0.5 ? 4 : sand > 0.5 ? 3 : fd > 0.55 ? 2 : 0;
        {
          const verge = smoothstep(0.35, 0.9, roadW[k]);
          const sandW = Math.max(sand, h < WL ? 1 : 0);
          // Waldboden nur unter dichtem Wald (vorher wirkte die ganze Landschaft braun)
          const dirtW = Math.min(1, smoothstep(0.35, 0.9, fd) * 0.75 + verge * 0.8 + (su === 1 ? 1 : 0));
          const grassW = Math.max(0, 1 - rock) * (1 - sandW) * (1 - dirtW * 0.85);
          splat[k * 4] = grassW * 255; splat[k * 4 + 1] = dirtW * 255; splat[k * 4 + 2] = rock * 255; splat[k * 4 + 3] = sandW * 255;
        }
        surf[k] = su;
        const v = 0.92 + 0.16 * (vnoise(x * 0.11, z * 0.11, 2) * 0.5 + 0.5);   // feine Helligkeitsvariation
        col[k * 3] = clamp(c[0] * v, 0, 255); col[k * 3 + 1] = clamp(c[1] * v, 0, 255); col[k * 3 + 2] = clamp(c[2] * v, 0, 255);
      }
    }
    this.col = col;
  }

  /** Häuserblöcke, Parks, Laternen, Ampeln, Zebrastreifen. */
  genCity() {
    const C = WORLD.city, rng = mulberry32(WORLD.seed + 7);
    const inset = C.streetHalf + 4;               // Straße + Gehweg
    this.blocks = []; this.parkTrees = [];
    for (let bi = 0; bi < C.lines - 1; bi++) {
      for (let bj = 0; bj < C.lines - 1; bj++) {
        const x0 = C.x0 + bi * C.spacing + inset, x1 = C.x0 + (bi + 1) * C.spacing - inset;
        const z0 = C.z0 + bj * C.spacing + inset, z1 = C.z0 + (bj + 1) * C.spacing - inset;
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const dc = Math.hypot(cx - C.cx, cz - C.cz);
        const park = (rng() < 0.11 && dc > 120) || (bi === 1 && bj === 5);
        this.blocks.push({ x0, x1, z0, z1, park });
        if (park) {
          for (let t = 0; t < 22; t++) this.parkTrees.push([lerp(x0 + 4, x1 - 4, rng()), lerp(z0 + 4, z1 - 4, rng())]);
          continue;
        }
        // Grundstücke: 1, 2 oder 4
        const lots = [];
        const r = rng();
        if (r < 0.22) lots.push([x0, x1, z0, z1]);
        else if (r < 0.55) { const m = lerp(x0, x1, 0.4 + rng() * 0.2); lots.push([x0, m, z0, z1], [m, x1, z0, z1]); }
        else { const mx = lerp(x0, x1, 0.4 + rng() * 0.2), mz = lerp(z0, z1, 0.4 + rng() * 0.2); lots.push([x0, mx, z0, mz], [mx, x1, z0, mz], [x0, mx, mz, z1], [mx, x1, mz, z1]); }
        const base = lerp(78, 12, smoothstep(40, 420, dc));
        for (const [a0, a1, b0, b1] of lots) {
          const m = 2 + rng() * 2.5;
          const bx0 = a0 + m, bx1 = a1 - m, bz0 = b0 + m, bz1 = b1 - m;
          if (bx1 - bx0 < 8 || bz1 - bz0 < 8) continue;
          const h = clamp(base * (0.45 + rng() * 0.9), 9, 125);
          const office = h > 32 || rng() < 0.25;
          this.addBuilding(bx0, bx1, bz0, bz1, C.h, h, office ? 0 : 1, rng);
          if (h > 45 && rng() < 0.55) {          // zurückgesetzter Turm obendrauf
            const sx = (bx1 - bx0) * 0.18, sz = (bz1 - bz0) * 0.18;
            this.addBuilding(bx0 + sx, bx1 - sx, bz0 + sz, bz1 - sz, C.h + h, h * (0.25 + rng() * 0.45), 0, rng);
          }
        }
      }
    }
    // Hangars am Flugplatz
    const A = WORLD.air;
    for (let k = 0; k < 3; k++) this.addBuilding(A.cx + 200 + k * 70, A.cx + 255 + k * 70, A.cz - A.hz - 50, A.cz - A.hz - 10, A.h, 14, 2, rng);

    // Straßenlaternen: Stadt beidseitig, Autobahn auf dem Mittelstreifen (Doppelausleger)
    for (const e of this.edges) {
      if (e.cls === 'city') {
        for (const s of [26, 50, 74]) {
          const p = this.pointOnEdge(e, s);
          for (const side of [-1, 1]) {
            const ox = -p.tz * side, oz = p.tx * side;   // rechts/links
            this.addLamp(p.x + ox * (C.streetHalf + 1.3), p.z + oz * (C.streetHalf + 1.3), C.h, Math.atan2(-ox, -oz), 1);
          }
        }
      } else if (e.cls === 'highway') {
        for (let s = 35; s < e.len - 20; s += 70) {
          const p = this.pointOnEdge(e, s);
          this.addLamp(p.x, p.z, p.y, Math.atan2(-p.tz, p.tx), 2);
        }
      }
    }
    // Ampeln + Zebrastreifen pro Zufahrt
    this.heads = []; this.crossings = [];
    for (const nd of this.nodes) {
      if (!nd.signal) continue;
      for (const e of nd.edges) {
        const other = e.a === nd ? e.b : e.a;
        const ax = Math.sign(other.x - nd.x), az = Math.sign(other.z - nd.z);   // Richtung zur Zufahrt
        // Fahrzeug kommt aus (ax,az) und fährt Richtung (−ax,−az); rechte Seite = (az, −ax)·(−1)
        const fx = -ax, fz = -az, rx = -fz, rz = fx;
        const hx = nd.x + ax * 9 + rx * 9, hz = nd.z + az * 9 + rz * 9;
        this.heads.push({ node: nd, axis: ax !== 0 ? 'EW' : 'NS', x: hx, z: hz, yaw: Math.atan2(ax, az) });
        this.crossings.push({ x: nd.x + ax * 10, z: nd.z + az * 10, along: ax !== 0 ? 'z' : 'x', stop: { x: nd.x + ax * 11.5 + rx * 3.5, z: nd.z + az * 11.5 + rz * 3.5, along: ax !== 0 ? 'z' : 'x' } });
      }
    }
  }

  addBuilding(x0, x1, z0, z1, y0, h, kind, rng) {
    const b = { x0, x1, z0, z1, y0, top: y0 + h, h, kind, tint: rng() };
    this.buildings.push(b);
    this.buildingHash.insert(x0, z0, x1, z1, b);
  }

  addLamp(x, z, y, yaw, kind) {
    const L = { x, z, y, yaw, kind, bulbs: [] };
    // Leuchtenkopf: 1,7 m Ausleger Richtung Straße auf 8 m Höhe
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    if (kind === 1) L.bulbs.push([x + dx * 1.7, y + 7.8, z + dz * 1.7]);
    else { L.bulbs.push([x + dx * 1.9, y + 9.8, z + dz * 1.9], [x - dx * 1.9, y + 9.8, z - dz * 1.9]); }
    this.lamps.push(L);
    for (const b of L.bulbs) this.lampHash.insert(b[0], b[2], b[0], b[2], b);
  }

  /** Bäume: dichter Wald nach Rauschen, vereinzelt auf Wiesen, Parkbäume in der Stadt. */
  genTrees() {
    const rng = mulberry32(WORLD.seed + 3);
    const { n, cell, half, H, surf, roadW } = this;
    const keep = this.q.treeDensity;
    const xs = [], zs = [], ys = [], ss = [], rs = [], ts = [], cs = [];
    const C = WORLD.city, A = WORLD.air;
    const step = 10.5;
    for (let gz = -half + 40; gz < half - 40; gz += step) {
      for (let gx = -half + 40; gx < half - 40; gx += step) {
        const x = gx + (rng() - 0.5) * step * 0.9, z = gz + (rng() - 0.5) * step * 0.9;
        const r1 = rng(), r2 = rng(), r3 = rng(), r4 = rng();
        const i = Math.round((x + half) / cell), j = Math.round((z + half) / cell);
        const k = j * n + i;
        const d = this.forestD[k] / 255;
        if (r1 > (d * 0.95 + 0.006) * keep) continue;
        const h = H[k];
        if (h < this.waterLevel + 1.3 || roadW[k] > 0.02 || this.slopeAt(i, j) > 0.85) continue;
        let nearRoad = false;
        for (let a = -2; a <= 2 && !nearRoad; a++) for (let b = -2; b <= 2; b++) { const kk = (j + b) * n + i + a; if (surf[kk] === 1 || roadW[kk] > 0.3) { nearRoad = true; break; } }
        if (nearRoad) continue;
        if (x > C.x0 - 30 && x < C.x1 + 30 && z > C.z0 - 30 && z < C.z1 + 30) continue;
        if (Math.abs(x - A.cx) < A.hx + 50 && Math.abs(z - A.cz) < A.hz + 70) continue;
        const conifer = h > 55 ? r2 < 0.85 : r2 < 0.38;
        xs.push(x); zs.push(z); ys.push(this.gridAt(H, x, z) - 0.2);
        ss.push(conifer ? 0.85 + r3 * 0.6 : 0.8 + r3 * 0.55); rs.push(r4 * Math.PI * 2); ts.push(conifer ? 0 : 1);
        cs.push(0.82 + r3 * 0.3);
      }
    }
    for (const [x, z] of this.parkTrees) {
      xs.push(x); zs.push(z); ys.push(C.h); ss.push(0.7 + rng() * 0.4); rs.push(rng() * 6.28); ts.push(1); cs.push(0.9 + rng() * 0.2);
    }
    const N = xs.length;
    this.trees = { count: N, x: Float32Array.from(xs), z: Float32Array.from(zs), y: Float32Array.from(ys), s: Float32Array.from(ss), r: Float32Array.from(rs), t: Uint8Array.from(ts), c: Float32Array.from(cs) };
  }

  genRamps() {
    const A = WORLD.air;
    const defs = [
      { x: A.cx - 300, z: A.cz, yaw: -Math.PI / 2, len: 18, width: 9, height: 3.4 },
      { x: A.cx + 200, z: A.cz, yaw: -Math.PI / 2, len: 34, width: 12, height: 7.5 },
      { x: A.cx + 620, z: A.cz + 12, yaw: Math.PI / 2, len: 14, width: 9, height: 2.6 },
      { x: A.cx - 620, z: A.cz - 12, yaw: -Math.PI / 2, len: 24, width: 10, height: 5 },
      { x: 560, z: -260, yaw: 0, len: 20, width: 9, height: 4.2 },
    ];
    for (const r of defs) {
      r.dx = -Math.sin(r.yaw); r.dz = -Math.cos(r.yaw);
      r.rx = Math.cos(r.yaw); r.rz = -Math.sin(r.yaw);
      r.sx = r.x - r.dx * r.len / 2; r.sz = r.z - r.dz * r.len / 2;
      r.slope = r.height / r.len;
      r.radius = Math.hypot(r.len, r.width) / 2 + 1;
      r.base = this.gridAt(this.H, r.x, r.z);
      this.ramps.push(r);
    }
  }

  // ---------------------------------------------------------------- Abfragen
  /** Punkt auf Kante bei Bogenlänge s (x, z, y, Tangente). */
  pointOnEdge(e, s, out = {}) {
    const pts = e.pts, f = clamp(s / e.sp, 0, pts.length - 1.0001), i = f | 0, t = f - i;
    const a = pts[i], b = pts[i + 1];
    out.x = a.x + (b.x - a.x) * t; out.z = a.z + (b.z - a.z) * t; out.y = a.y + (b.y - a.y) * t;
    out.tx = a.tx + (b.tx - a.tx) * t; out.tz = a.tz + (b.tz - a.tz) * t;
    const l = Math.hypot(out.tx, out.tz) || 1; out.tx /= l; out.tz /= l;
    return out;
  }

  /**
   * Höhe + Normale. yRef (optional): Höhe des Abfragenden – Dächer zählen nur,
   * wenn man von oben kommt (sonst würde eine Hauswand das Auto „hochheben“).
   */
  sample(x, z, outN, yRef) {
    const { n, cell, half, H } = this;
    const gx = clamp((x + half) / cell, 0, n - 1.001), gz = clamp((z + half) / cell, 0, n - 1.001);
    const i = gx | 0, j = gz | 0, fx = gx - i, fz = gz - j, k = j * n + i;
    const h00 = H[k], h10 = H[k + 1], h01 = H[k + n], h11 = H[k + n + 1];
    let h = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
    let gxv = ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) / cell;
    let gzv = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) / cell;
    // Brücke
    const br = this.bridgeHash.at(x, z);
    for (let a = 0; a < br.length; a++) {
      const s = br[a];
      const t = ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.len2;
      if (t < 0 || t > 1) continue;
      const lat = Math.abs((x - s.ax) * s.dz - (z - s.az) * s.dx) / Math.sqrt(s.len2);
      if (lat > s.halfW) continue;
      const y = s.ay + (s.by - s.ay) * t;
      if (y > h) { h = y; gxv = s.gx; gzv = s.gz; }
    }
    // Dächer
    if (yRef !== undefined) {
      const bs = this.buildingHash.at(x, z);
      for (let a = 0; a < bs.length; a++) {
        const b = bs[a];
        if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && yRef > b.top - 1.2 && b.top > h) { h = b.top; gxv = 0; gzv = 0; }
      }
    }
    // Rampen
    for (let a = 0; a < this.ramps.length; a++) {
      const r = this.ramps[a];
      const ox = x - r.x, oz = z - r.z;
      if (ox * ox + oz * oz > r.radius * r.radius) continue;
      const u = (x - r.sx) * r.dx + (z - r.sz) * r.dz, w = ox * r.rx + oz * r.rz;
      if (u < 0 || u > r.len || Math.abs(w) > r.width / 2) continue;
      const rh = r.base + u * r.slope;
      if (rh > h) { h = rh; gxv = r.slope * r.dx; gzv = r.slope * r.dz; }
    }
    if (outN) outN.set(-gxv, 1, -gzv).normalize();
    return h;
  }

  surfaceAt(x, z) {
    const { n, cell, half } = this;
    const i = clamp(Math.round((x + half) / cell), 0, n - 1), j = clamp(Math.round((z + half) / cell), 0, n - 1);
    return this.surf[j * n + i];
  }
  grip(x, z) { const s = this.surfaceAt(x, z); return SURF_GRIP[s] * (1 - (this.wet || 0) * (s === 1 ? 0.22 : 0.12)); }
  roll(x, z) { return SURF_ROLL[this.surfaceAt(x, z)]; }
  isWater(x, z) { return this.sample(x, z) < this.waterLevel - 0.05; }

  /** Nächste Straßenposition (rechte Fahrspur, passende Richtung) – für Zurücksetzen/Spawn. */
  nearestRoadPose(x, z, yawHint = 0) {
    let best = null, bd = 1e18;
    for (const r of [80, 250, 700, 2500]) {
      this.roadPointHash.near(x, z, r, (it) => {
        const p = it.e.pts[it.i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bd && !p.bridge) { bd = d; best = it; }
      });
      if (best) break;
    }
    if (!best) return { x: 0, z: 0, yaw: 0 };
    const p = best.e.pts[best.i];
    const fx = -Math.sin(yawHint), fz = -Math.cos(yawHint);
    const dir = fx * p.tx + fz * p.tz >= 0 ? 1 : -1;
    const tx = p.tx * dir, tz = p.tz * dir;
    const lane = best.e.C.lanes[best.e.C.lanes.length - 1];
    return { x: p.x - tz * lane, z: p.z + tx * lane, yaw: Math.atan2(-tx, -tz), edge: best.e };
  }

  /** Ampelphase einer Achse ('NS'/'EW') an einem Knoten: 'G', 'Y' oder 'R'. */
  signalState(nd, axis) {
    const t = (this.time + nd.phase) % 30;
    if (axis === 'NS') return t < 12 ? 'G' : t < 15 ? 'Y' : 'R';
    return t >= 15 && t < 27 ? 'G' : t >= 27 ? 'Y' : 'R';
  }

  /** Liegt ein Punkt in einem Gebäude (für die Kamera)? */
  insideBuilding(x, y, z) {
    const bs = this.buildingHash.at(x, z);
    for (let a = 0; a < bs.length; a++) { const b = bs[a]; if (x > b.x0 - 0.3 && x < b.x1 + 0.3 && z > b.z0 - 0.3 && z < b.z1 + 0.3 && y < b.top + 0.3 && y > b.y0 - 1) return true; }
    return false;
  }

  /** Kamera nicht hinter Hauswänden verschwinden lassen: Anteil 0..1 der freien Strecke. */
  cameraClip(from, to) {
    const steps = 10;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      if (this.insideBuilding(lerp(from.x, to.x, t), lerp(from.y, to.y, t), lerp(from.z, to.z, t))) return Math.max(0.15, (k - 1.3) / steps);
    }
    return 1;
  }

  // ---------------------------------------------------------------- Kollision
  /**
   * Fahrzeug gegen Gebäudewände und Leitplanken. Das Auto wird als Rechteck
   * (Draufsicht) mit 8 Randpunkten geprüft, die Antwort ist ein Impuls am
   * Kontaktpunkt (mit Drehung), wenig Rückprall, etwas Reibung.
   */
  collideVehicle(v) {
    const f = v._v[11].set(0, 0, -1).applyQuaternion(v.quat);
    let fx = f.x, fz = f.z; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const rx = -fz, rz = fx;
    const HX = 0.98, HZ = 2.28;
    const px = v.pos.x, pz = v.pos.z;
    if (!this._pts) this._pts = Array.from({ length: 8 }, () => [0, 0]);
    const P = this._pts;
    const loc = [[-HX, -HZ], [HX, -HZ], [-HX, HZ], [HX, HZ], [-HX, 0], [HX, 0], [0, -HZ], [0, HZ]];
    for (let i = 0; i < 8; i++) {
      const [lx, lz] = loc[i];
      P[i][0] = px + rx * lx - fx * lz; P[i][1] = pz + rz * lx - fz * lz;
    }
    const bottom = v.pos.y - 0.4;
    const stamp = ++this._stamp;
    // Gebäude (achsenparallele Quader)
    this.buildingHash.near(px, pz, 4, (b) => {
      if (b._st === stamp) return; b._st = stamp;
      if (bottom > b.top - 0.3 || v.pos.y + 0.8 < b.y0) return;
      // 1) Autopunkte im Gebäude
      for (let i = 0; i < 8; i++) {
        const [x, z] = P[i];
        if (x <= b.x0 || x >= b.x1 || z <= b.z0 || z >= b.z1) continue;
        const dl = x - b.x0, dr = b.x1 - x, dn = z - b.z0, ds = b.z1 - z;
        const m = Math.min(dl, dr, dn, ds);
        if (m === dl) this.resolveContact(v, x, z, -1, 0, dl);
        else if (m === dr) this.resolveContact(v, x, z, 1, 0, dr);
        else if (m === dn) this.resolveContact(v, x, z, 0, -1, dn);
        else this.resolveContact(v, x, z, 0, 1, ds);
      }
      // 2) Hausecken im Auto
      for (const [cx, cz] of [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]]) {
        const lx = (cx - v.pos.x) * rx + (cz - v.pos.z) * rz, lz = -((cx - v.pos.x) * fx + (cz - v.pos.z) * fz);
        if (Math.abs(lx) >= HX || Math.abs(lz) >= HZ) continue;
        const pxd = HX - Math.abs(lx), pzd = HZ - Math.abs(lz);
        if (pxd < pzd) { const s = -Math.sign(lx); this.resolveContact(v, cx, cz, rx * s, rz * s, pxd); }
        else { const s = Math.sign(lz); this.resolveContact(v, cx, cz, fx * s, fz * s, pzd); }
      }
    });
    // Bäume
    this.collideTrees(v, px, pz, fx, fz, rx, rz, HX, HZ, stamp);
    // Leitplanken (Liniensegmente mit Dicke; man kann sie überspringen)
    this.barrierHash.near(px, pz, 3, (s) => {
      if (s._st === stamp) return; s._st = stamp;
      if (bottom > s.top) return;
      const cside = (px - s.ax) * s.nx + (pz - s.az) * s.nz;
      const sign = cside >= 0 ? 1 : -1;
      const nx = s.nx * sign, nz = s.nz * sign;
      for (let i = 0; i < 8; i++) {
        const [x, z] = P[i];
        const t = ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.len2;
        if (t < 0 || t > 1) continue;
        const dist = (x - s.ax) * nx + (z - s.az) * nz;
        if (dist < 0.22) this.resolveContact(v, x, z, nx, nz, 0.22 - dist);
      }
    });
  }

  resolveContact(v, x, z, nx, nz, depth) {
    v.pos.x += nx * depth; v.pos.z += nz * depth;
    const t = v._v;
    const r = t[4].set(x - v.pos.x, -0.15, z - v.pos.z);
    const n = t[5].set(nx, 0, nz);
    const pv = t[6].crossVectors(v.angVel, r).add(v.vel);
    const vn = pv.dot(n);
    if (vn >= 0) return;
    const rn = t[7].crossVectors(r, n);
    const k = v.invMass + v.applyInvInertia(t[8].copy(rn)).cross(r).dot(n);
    const jn = -(1 + 0.12) * vn / k;
    const J = t[8].copy(n).multiplyScalar(jn);
    const vt = t[9].copy(pv).addScaledVector(n, -vn); vt.y = 0;
    const vtl = vt.length();
    if (vtl > 1e-3) J.addScaledVector(vt, -Math.min(vtl / k, 0.3 * jn) / vtl);
    v.vel.addScaledVector(J, v.invMass);
    v.angVel.add(v.applyInvInertia(t[10].crossVectors(r, J)));
    if (-vn > 2.5) { v.lastImpact = Math.max(v.lastImpact, -vn); if (this.fx.length < 30) this.fx.push({ type: 'spark', x, y: v.pos.y - 0.1, z, s: -vn, nx, nz }); }
    else if (vt.length() > 4 && Math.random() < 0.3 && this.fx.length < 30) this.fx.push({ type: 'scrape', x, y: v.pos.y - 0.15, z, s: vt.length() });
  }
}

// ============================== Welt: Texturen ==============================
/**
 * Kachelbare Bodentexturen (256², Mittelwert ≈ 0,5, linear): werden mit der
 * Bodenfarbe multipliziert und bringen die Struktur – Halme, Laub, Risse, Körnung.
 */
function makeGroundTextures() {
  const S = 256;
  const make = (base, seed, paint) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const c = cv.getContext('2d'), rng = mulberry32(seed);
    c.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`; c.fillRect(0, 0, S, S);
    // überall neunfach zeichnen (versetzt um ±S), damit die Ränder nahtlos sind
    const wrap = (fn) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { c.save(); c.translate(ox, oy); fn(c); c.restore(); } };
    paint(c, rng, wrap);
    const img = c.getImageData(0, 0, S, S), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const nn = (rng() - 0.5) * 16; d[i] += nn; d[i + 1] += nn; d[i + 2] += nn; }
    c.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    return t;
  };
  const blots = (c, rng, wrap, n, rMin, rMax, cols) => {
    const list = Array.from({ length: n }, () => [rng() * S, rng() * S, rMin + rng() * (rMax - rMin), cols[Math.floor(rng() * cols.length)], rng() * 3]);
    wrap((cc) => { for (const [x, y, r, col, a] of list) { cc.fillStyle = col; cc.beginPath(); cc.ellipse(x, y, r, r * 0.6, a, 0, Math.PI * 2); cc.fill(); } });
  };
  const grass = make([116, 132, 98], 1, (c, rng, wrap) => {
    blots(c, rng, wrap, 40, 10, 34, ['rgba(160,165,120,0.18)', 'rgba(80,90,60,0.2)']);
    const blades = Array.from({ length: 2600 }, () => [rng() * S, rng() * S, 3 + rng() * 7, rng() * Math.PI, rng()]);
    wrap((cc) => { cc.lineWidth = 1; for (const [x, y, l, a, t] of blades) { cc.strokeStyle = t < 0.5 ? `rgba(70,${(90 + t * 60) | 0},40,0.55)` : `rgba(${(170 + t * 40) | 0},${(180 + t * 40) | 0},120,0.4)`; cc.beginPath(); cc.moveTo(x, y); cc.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); cc.stroke(); } });
  });
  const dirt = make([128, 118, 104], 2, (c, rng, wrap) => {
    blots(c, rng, wrap, 60, 6, 22, ['rgba(70,55,40,0.25)', 'rgba(170,150,120,0.2)']);
    blots(c, rng, wrap, 420, 1.5, 5, ['rgba(150,95,45,0.75)', 'rgba(110,70,35,0.75)', 'rgba(170,130,60,0.7)', 'rgba(90,100,50,0.6)', 'rgba(60,45,30,0.7)']);
    const twigs = Array.from({ length: 70 }, () => [rng() * S, rng() * S, 8 + rng() * 22, rng() * Math.PI]);
    wrap((cc) => { cc.strokeStyle = 'rgba(70,52,36,0.8)'; cc.lineWidth = 1.5; for (const [x, y, l, a] of twigs) { cc.beginPath(); cc.moveTo(x, y); cc.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); cc.stroke(); } });
  });
  const rock = make([126, 124, 120], 3, (c, rng, wrap) => {
    blots(c, rng, wrap, 90, 8, 40, ['rgba(90,88,86,0.3)', 'rgba(170,168,160,0.25)', 'rgba(120,110,95,0.25)']);
    const cracks = Array.from({ length: 45 }, () => { const pts = [[rng() * S, rng() * S]]; for (let k = 0; k < 6; k++) { const [x, y] = pts[pts.length - 1]; pts.push([x + (rng() - 0.5) * 30, y + (rng() - 0.3) * 22]); } return pts; });
    wrap((cc) => { cc.strokeStyle = 'rgba(45,42,40,0.7)'; cc.lineWidth = 1.2; for (const pts of cracks) { cc.beginPath(); pts.forEach(([x, y], i) => (i ? cc.lineTo(x, y) : cc.moveTo(x, y))); cc.stroke(); } });
  });
  const sand = make([136, 130, 118], 4, (c, rng, wrap) => {
    wrap((cc) => { cc.strokeStyle = 'rgba(100,92,80,0.18)'; cc.lineWidth = 2; for (let y = 0; y < S; y += 9) { cc.beginPath(); for (let x = 0; x <= S; x += 8) cc.lineTo(x, y + Math.sin(x / S * Math.PI * 4) * 3); cc.stroke(); } });
    blots(c, rng, wrap, 500, 0.6, 1.6, ['rgba(80,72,60,0.6)', 'rgba(190,180,160,0.6)']);
  });
  return { grass, dirt, rock, sand };
}

/** Weicher Schattenfleck (Kontaktschatten unter Fahrzeugen). */
function makeBlobTexture() {
  const W = 128, H = 256, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d'), img = c.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = Math.abs(x / W - 0.5) * 2, v = Math.abs(y / H - 0.5) * 2;
    const q = Math.pow(Math.pow(u, 4) + Math.pow(v, 4), 0.25);          // abgerundetes Rechteck
    const a = clamp(1 - smoothstep(0.55, 1.0, q), 0, 1);
    const k = (y * W + x) * 4; d[k] = d[k + 1] = d[k + 2] = 0; d[k + 3] = a * 255;
  }
  c.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(cv);
}

/** Wie mergeParts, übernimmt aber auch UV-Koordinaten (für texturierte Bäume). */
function mergeUV(parts) {
  const g = mergeParts(parts);
  const uv = new Float32Array(g.attributes.position.count * 2);
  let o = 0;
  for (const p of parts) {
    const src = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    const a = src.attributes.uv, n = src.attributes.position.count;
    if (a) uv.set(a.array.subarray(0, n * 2), o * 2);
    o += n;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * Laub-Atlas (512²): links oben Rinde, links unten dichtes Laub (opak),
 * Mitte Blätterbüschel mit Transparenz, rechts Nadelzweige mit zackiger Unterkante.
 */
function makeFoliageAtlas() {
  const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d'), rng = mulberry32(31);
  // Rinde (oben links)
  // Rinde: Grundton mit Längsverlauf, rissige Borke (geschwungene dunkle Furchen, helle Plattenkanten),
  // vereinzelt Moos/Flechten – wirkt plastisch, ohne Normal-Map
  { const g = c.createLinearGradient(0, 0, 96, 0);
    g.addColorStop(0, '#3e3228'); g.addColorStop(0.5, '#5e4d3d'); g.addColorStop(1, '#3a2f26');
    c.fillStyle = g; c.fillRect(0, 0, 96, 256); }
  for (let f = 0; f < 15; f++) {
    let x = rng() * 96; const w0 = 1.2 + rng() * 2.4;
    c.strokeStyle = `rgba(18,13,9,${0.55 + rng() * 0.35})`; c.lineWidth = w0; c.beginPath(); c.moveTo(x, 0);
    for (let y = 0; y <= 256; y += 8) { x += (rng() - 0.5) * 5; c.lineTo(x, y); }
    c.stroke();
    c.strokeStyle = 'rgba(150,128,104,0.3)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x + w0, 0);      // helle Kante neben der Furche
    for (let y = 0; y <= 256; y += 8) c.lineTo(x + w0 + (rng() - 0.5) * 2, y);
    c.stroke();
  }
  for (let i = 0; i < 70; i++) { c.fillStyle = `rgba(20,15,10,${0.3 + rng() * 0.3})`; c.fillRect(rng() * 96, rng() * 256, 3 + rng() * 10, 1 + rng() * 1.5); }   // Querrisse
  for (let i = 0; i < 26; i++) { c.fillStyle = `rgba(${90 + rng() * 30},${110 + rng() * 30},${60 + rng() * 20},0.35)`; c.beginPath(); c.ellipse(rng() * 96, rng() * 256, 2 + rng() * 5, 2 + rng() * 6, 0, 0, 6.3); c.fill(); }   // Moos
  // Dichtes Laub (unten links, opak)
  c.fillStyle = '#2f4a1f'; c.fillRect(0, 256, 96, 256);
  for (let i = 0; i < 900; i++) { const l = 14 + rng() * 26; c.fillStyle = `hsl(${88 + rng() * 22},${38 + rng() * 22}%,${l}%)`; c.beginPath(); c.ellipse(rng() * 96, 256 + rng() * 256, 2 + rng() * 4, 1.5 + rng() * 2.5, rng() * 3, 0, Math.PI * 2); c.fill(); }
  // Blätterbüschel (Mitte, mit Lücken)
  const lx0 = 102, lw = 205;
  for (let b = 0; b < 26; b++) {
    const bx = lx0 + 20 + rng() * (lw - 40), by = 20 + rng() * (S - 40), br = 30 + rng() * 40;
    for (let i = 0; i < 150; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * br;
      const x = bx + Math.cos(a) * d, y = by + Math.sin(a) * d * 0.85;
      if (x < lx0 + 3 || x > lx0 + lw - 3) continue;
      const l = 16 + rng() * 28 + (1 - d / br) * 6;
      c.fillStyle = `hsl(${82 + rng() * 26},${40 + rng() * 25}%,${l}%)`;
      c.beginPath(); c.ellipse(x, y, 3 + rng() * 4, 2 + rng() * 2.5, rng() * 3.14, 0, Math.PI * 2); c.fill();
    }
  }
  // Nadelzweige (rechts): Bereich mit zackiger Unterkante (v = 0 unten)
  const nx0 = 313, nw = S - nx0;
  c.save();
  c.beginPath(); c.moveTo(nx0, 0); c.lineTo(S, 0); c.lineTo(S, S - 60);
  for (let x = S; x >= nx0; x -= 10) c.lineTo(x - 5, S - 4 - rng() * 22), c.lineTo(x - 10, S - 50 - rng() * 30);
  c.closePath(); c.clip();
  c.fillStyle = '#1c3016'; c.fillRect(nx0, 0, nw, S);
  for (let i = 0; i < 4200; i++) {
    const x = nx0 + rng() * nw, y = rng() * S, len = 5 + rng() * 9, a = Math.PI / 2 + (rng() - 0.5) * 1.2;
    c.strokeStyle = `hsl(${100 + rng() * 30},${30 + rng() * 25}%,${12 + rng() * 22}%)`; c.lineWidth = 1 + rng();
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * len * 0.4, y + Math.sin(a) * len); c.stroke();
  }
  c.restore();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Gehwegplatten (50 cm, Betongrau mit Fugen und leichter Fleckigkeit), Kachel = 3 m. */
function makePavingTexture() {
  const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d'), rng = mulberry32(808), n = 6, cs = S / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = 150 + rng() * 26;
    c.fillStyle = `rgb(${v},${v - 2},${v - 6})`; c.fillRect(i * cs, j * cs, cs, cs);
    for (let k = 0; k < 6; k++) { c.fillStyle = `rgba(${rng() < 0.5 ? '0,0,0' : '255,255,255'},0.05)`; c.beginPath(); c.arc(i * cs + rng() * cs, j * cs + rng() * cs, 4 + rng() * 18, 0, 6.3); c.fill(); }
  }
  c.strokeStyle = 'rgba(60,58,54,0.85)'; c.lineWidth = 3;
  for (let k = 0; k <= n; k++) { c.beginPath(); c.moveTo(k * cs, 0); c.lineTo(k * cs, S); c.stroke(); c.beginPath(); c.moveTo(0, k * cs); c.lineTo(S, k * cs); c.stroke(); }
  const img = c.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const nn = (rng() - 0.5) * 16; d[i] += nn; d[i + 1] += nn; d[i + 2] += nn; }
  c.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

/** Feine Asphalt-Körnung als Bump-Map (Glanzpunkte auf dem Splitt im Streiflicht). */
function makeGrainTexture() {
  const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(N, N), d = img.data, rng = mulberry32(31337);
  for (let i = 0; i < d.length; i += 4) { const v = 128 + (rng() - 0.5) * 90 + (rng() < 0.05 ? 70 : 0); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}

/** Fahrbahn-Textur mit Markierungen (u = quer, v = längs). Alles per Canvas, keine Dateien. */
function makeRoadTexture(kind) {
  const spec = {
    highway: { w: 22, len: 18 }, country: { w: 8.4, len: 18 }, city: { w: 14, len: 18 },
    runway: { w: 60, len: 50 }, plain: { w: 16, len: 16 },
  }[kind];
  const W = 512, Hh = 512, cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
  const ctx = cv.getContext('2d');
  const pxm = W / spec.w, pyl = Hh / spec.len;
  // Asphalt: Grundton, Körnung, Flecken
  // realistischer, leicht warmgrauer, ausgeblichener Asphalt (nicht schwarz-blau)
  ctx.fillStyle = kind === 'runway' ? '#55555a' : kind === 'highway' ? '#52504e' : '#5a5854'; ctx.fillRect(0, 0, W, Hh);
  const rng = mulberry32(kind.length * 977);
  for (let i = 0; i < 90; i++) {
    const x = rng() * W, y = rng() * Hh, g = ctx.createRadialGradient(x, y, 0, x, y, 20 + rng() * 90);
    const dark = rng() < 0.55;
    g.addColorStop(0, dark ? 'rgba(10,8,6,0.14)' : 'rgba(255,250,240,0.06)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, Hh);
  }
  // Flickstellen (dunkler, rechteckig) und Risse mit Bitumen-Vergussmasse
  for (let i = 0; i < (kind === 'runway' ? 3 : 6); i++) {
    ctx.fillStyle = `rgba(20,20,22,${0.12 + rng() * 0.14})`;
    ctx.fillRect(rng() * W, rng() * Hh, 20 + rng() * 90, 14 + rng() * 60);
  }
  ctx.strokeStyle = 'rgba(14,13,12,0.38)'; ctx.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    let x = rng() * W, y = rng() * Hh; ctx.lineWidth = 1 + rng() * 2.2; ctx.beginPath(); ctx.moveTo(x, y);
    const dir = rng() < 0.6 ? 0 : 1;
    for (let k = 0; k < 8; k++) { x += dir ? (rng() - 0.5) * 30 : (rng() - 0.5) * 70; y += dir ? 8 + rng() * 22 : (rng() - 0.5) * 22; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  // Körnung: Splitt (helle Steinchen) + Feinrauschen
  const img = ctx.getImageData(0, 0, W, Hh), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let nn = (rng() - 0.5) * 22;
    const r = rng(); if (r < 0.035) nn += 30 + rng() * 25; else if (r < 0.07) nn -= 22;
    d[i] += nn; d[i + 1] += nn * 0.98; d[i + 2] += nn * 0.95;
  }
  ctx.putImageData(img, 0, 0);
  const band = (x0m, wm, color, dashOn, dashLen) => {
    ctx.fillStyle = color;
    const x = x0m * pxm, w = Math.max(1.5, wm * pxm);
    if (!dashOn) { ctx.fillRect(x, 0, w, Hh); return; }
    for (let v = 0; v < spec.len; v += dashLen) ctx.fillRect(x, v * pyl, w, dashOn * pyl);
  };
  const tracks = (centerM) => {   // Reifenspuren: glattgefahrene, dunklere Bänder + Ölspur in der Spurmitte
    for (const o of [-0.85, 0.85]) {
      const g = ctx.createLinearGradient((centerM + o - 0.45) * pxm, 0, (centerM + o + 0.45) * pxm, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.13)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect((centerM + o - 0.45) * pxm, 0, 0.9 * pxm, Hh);
    }
    const g = ctx.createLinearGradient((centerM - 0.35) * pxm, 0, (centerM + 0.35) * pxm, 0);
    g.addColorStop(0, 'rgba(20,16,10,0)'); g.addColorStop(0.5, 'rgba(20,16,10,0.12)'); g.addColorStop(1, 'rgba(20,16,10,0)');
    ctx.fillStyle = g; ctx.fillRect((centerM - 0.35) * pxm, 0, 0.7 * pxm, Hh);
  };
  const white = 'rgba(232,232,224,0.86)';
  if (kind === 'highway') {
    const c = 11;
    for (const s of [-1, 1]) {
      tracks(c + s * 2.7); tracks(c + s * 6.3);
      band(c + s * 8.1 - (s > 0 ? 0 : 0.25), 0.25, white);                 // Randlinie
      band(c + s * 4.5 - 0.075, 0.15, white, 6, 18);                         // Leitlinie
      band(c + s * 0.9 - (s > 0 ? 0 : 0.15), 0.15, white);                   // innere Randlinie
      ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(s > 0 ? (c + 8.3) * pxm : 0, 0, 2.7 * pxm, Hh); // Standstreifen
    }
    ctx.fillStyle = '#6d6e6f'; ctx.fillRect((c - 0.6) * pxm, 0, 1.2 * pxm, Hh);  // Mittelstreifen (Beton)
  } else if (kind === 'country') {
    const c = 4.2;
    tracks(c - 2); tracks(c + 2);
    band(0.35, 0.12, white); band(8.4 - 0.47, 0.12, white);
    band(c - 0.06, 0.12, white, 3, 9);
  } else if (kind === 'city') {
    const c = 7;
    tracks(c - 2.4); tracks(c + 2.4);
    band(c - 0.07, 0.14, white, 3, 9);
    band(c - 4.6, 0.12, 'rgba(236,236,230,0.6)'); band(c + 4.48, 0.12, 'rgba(236,236,230,0.6)');
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, 0.35 * pxm, Hh); ctx.fillRect(W - 0.35 * pxm, 0, 0.35 * pxm, Hh);
  } else if (kind === 'runway') {
    band(1.5, 1, white); band(57.5, 1, white);
    band(29.5, 1, white, 30, 50);
  }
  // abgefahrene Markierung: Fehlstellen in der Farbe
  ctx.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 260; i++) { ctx.fillStyle = `rgba(70,68,64,${0.25 + rng() * 0.4})`; ctx.fillRect(rng() * W, rng() * Hh, 2 + rng() * 6, 2 + rng() * 6); }
  ctx.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = kind === 'plain' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.userData.len = spec.len; t.userData.w = spec.w;
  return t;
}

/** Fassaden-Textur (Farbe + nächtliche Fenster). Kachel = 8 Fenster × 8 Etagen. */
function makeFacadeTextures(kind) {
  const S = 512, cells = 8, cs = S / cells;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const em = document.createElement('canvas'); em.width = em.height = S;
  const c = cv.getContext('2d'), e = em.getContext('2d');
  const rng = mulberry32(kind * 101 + 7);
  e.fillStyle = '#000'; e.fillRect(0, 0, S, S);
  if (kind === 0) {            // Bürohaus: Glasfassade
    c.fillStyle = '#b9bdc2'; c.fillRect(0, 0, S, S);
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
      const x = i * cs, y = j * cs;
      const g = c.createLinearGradient(x, y, x + cs, y + cs);
      const b = 40 + rng() * 25;
      g.addColorStop(0, `rgb(${b + 18},${b + 32},${b + 48})`); g.addColorStop(1, `rgb(${b},${b + 10},${b + 22})`);
      c.fillStyle = g; c.fillRect(x + 3, y + 6, cs - 6, cs - 16);
      c.fillStyle = 'rgba(30,34,40,0.9)'; c.fillRect(x, y + cs - 10, cs, 6);              // Brüstung
      if (rng() < 0.34) { e.fillStyle = rng() < 0.6 ? '#ffd79a' : '#cfe0f5'; e.globalAlpha = 0.25 + rng() * 0.6; e.fillRect(x + 3, y + 6, cs - 6, cs - 16); }
    }
  } else {                     // Wohnhaus / Halle: helle Wand, Lochfenster
    c.fillStyle = '#e4e0d8'; c.fillRect(0, 0, S, S);
    const img = c.getImageData(0, 0, S, S), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const nn = (rng() - 0.5) * 14; d[i] += nn; d[i + 1] += nn; d[i + 2] += nn; }
    c.putImageData(img, 0, 0);
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
      const x = i * cs, y = j * cs;
      if (kind === 2) { if (j % 4 === 0 && i % 2 === 0) { c.fillStyle = '#4a5058'; c.fillRect(x + 6, y + 8, cs - 12, 14); } continue; }
      c.fillStyle = '#8f8a82'; c.fillRect(x + 15, y + 13, cs - 30, cs - 22);
      c.fillStyle = '#262a30'; c.fillRect(x + 17, y + 15, cs - 34, cs - 26);
      c.fillStyle = 'rgba(160,190,220,0.25)'; c.fillRect(x + 17, y + 15, (cs - 34) / 2, cs - 26);
      c.fillStyle = '#cfc9bf'; c.fillRect(x + 12, y + cs - 10, cs - 24, 4);              // Fensterbank
      if (rng() < 0.3) { e.fillStyle = rng() < 0.75 ? '#ffc070' : '#c8dcf5'; e.globalAlpha = 0.3 + rng() * 0.6; e.fillRect(x + 17, y + 15, cs - 34, cs - 26); }
    }
  }
  const mk = (canvas, srgb) => { const t = new THREE.CanvasTexture(canvas); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  return { map: mk(cv, true), emissive: mk(em, true) };
}

/** Graustufen-Detailtextur für den Boden (wird mit der Bodenfarbe multipliziert). */
function makeDetailTexture() {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // kachelbares Rauschen: mehrere periodische Oktaven
    let v = 0, a = 1, f = 4, n = 0;
    for (let o = 0; o < 4; o++) {
      const px = x / S * f, py = y / S * f;
      const i = Math.floor(px), j = Math.floor(py), fx = px - i, fy = py - j;
      const h = (ii, jj) => hash2(((ii % f) + f) % f, ((jj % f) + f) % f, 40 + o);
      const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
      v += a * lerp(lerp(h(i, j), h(i + 1, j), u), lerp(h(i, j + 1), h(i + 1, j + 1), u), w);
      n += a; a *= 0.55; f *= 2;
    }
    const g = 222 + (v / n) * 34 + (Math.random() - 0.5) * 18;
    const k = (y * S + x) * 4; d[k] = d[k + 1] = d[k + 2] = clamp(g, 0, 255); d[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Normal-Map für Wasserwellen (kachelbar). */
function makeWaterNormal() {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(S, S), d = img.data;
  const hgt = (x, y) => Math.sin((x / S) * Math.PI * 2 * 3 + Math.sin((y / S) * Math.PI * 2 * 2) * 1.5) * 0.5
    + Math.sin((y / S) * Math.PI * 2 * 5 + Math.cos((x / S) * Math.PI * 2 * 3)) * 0.35
    + Math.sin(((x + y) / S) * Math.PI * 2 * 7) * 0.15;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = hgt(x + 1, y) - hgt(x - 1, y), dy = hgt(x, y + 1) - hgt(x, y - 1);
    const nx = -dx * 2, ny = -dy * 2, nz = 1, l = Math.hypot(nx, ny, nz);
    const k = (y * S + x) * 4;
    d[k] = (nx / l * 0.5 + 0.5) * 255; d[k + 1] = (ny / l * 0.5 + 0.5) * 255; d[k + 2] = (nz / l * 0.5 + 0.5) * 255; d[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function radialTexture(inner, outer) {
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d'), g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, inner); g.addColorStop(0.45, 'rgba(255,255,255,0.35)'); g.addColorStop(1, outer);
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(cv);
}

// ============================== Welt: Aufbau der Darstellung ==============================
Object.assign(World.prototype, {
  build(scene, camera) {
    this.scene = scene; this.camera = camera;
    this.group = new THREE.Group(); scene.add(this.group);
    this.buildTerrain();
    this.buildWater();
    this.buildRoads();
    this.buildRails();
    this.buildLamps();
    this.buildCity();
    this.buildTrees();
    this.buildRamps();
    this.setupFallers();
    this.updateTimers = { lod: 0, trees: 0, sig: 0, lights: 0 };
    this.lastTreePos = new THREE.Vector3(1e9, 0, 0);
    this.frustum = new THREE.Frustum(); this._pm = new THREE.Matrix4();
  },

  // ---------- Gelände in Kacheln mit 3 Detailstufen ----------
  buildTerrain() {
    this.lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const c = i / 255; this.lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    const det = makeDetailTexture();
    void det;
    const GT = makeGroundTextures();
    this.terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    // Texturen nach Untergrund mischen (Gras/Waldboden/Fels/Sand), zwei Maßstäbe gegen sichtbare Kachelung
    this.terrainMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { tG: { value: GT.grass }, tD: { value: GT.dirt }, tR: { value: GT.rock }, tS: { value: GT.sand } });
      sh.vertexShader = 'attribute vec4 splat; varying vec4 vSplat; varying vec2 vWXZ; varying float vNY; varying float vHY;\n' + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vSplat = splat; vWXZ = position.xz; vNY = normal.y; vHY = position.y;');
      sh.fragmentShader = 'uniform sampler2D tG; uniform sampler2D tD; uniform sampler2D tR; uniform sampler2D tS; varying vec4 vSplat; varying vec2 vWXZ; varying float vNY; varying float vHY;\n' + sh.fragmentShader
        .replace('#include <map_fragment>', `
          vec2 ua = vWXZ / 4.5, ub = vWXZ / 17.0 + 0.37;
          vec4 w = vSplat / max(vSplat.x + vSplat.y + vSplat.z + vSplat.w, 0.001);
          // Steilhänge werden felsig, Hangfüße erdig; großräumiges Rauschen bricht die Kachelung in der Ferne
          float slope = 1.0 - vNY;
          float mac = texture2D(tD, vWXZ / 210.0).r * 0.6 + texture2D(tG, vWXZ / 77.0 + 0.5).g * 0.4;
          float rk = smoothstep(0.2, 0.42, slope + (mac - 0.5) * 0.15);
          float er = smoothstep(0.1, 0.22, slope) * (1.0 - rk) * 0.6;
          w = vec4(w.x * (1.0 - rk - er), w.y * (1.0 - rk) + er, w.z * (1.0 - rk) + rk, w.w * (1.0 - rk));
          // trockene Grasflecken
          w.x *= 1.0; vec4 wDry = w;
          vec3 tg = texture2D(tG, ua).rgb * 0.6 + texture2D(tG, ub).rgb * 0.4;
          vec3 td = texture2D(tD, ua).rgb * 0.6 + texture2D(tD, ub).rgb * 0.4;
          vec3 tr = texture2D(tR, ua * 0.55).rgb * 0.6 + texture2D(tR, ub * 0.8).rgb * 0.4;
          vec3 ts = texture2D(tS, ua).rgb * 0.6 + texture2D(tS, ub).rgb * 0.4;
          // Ferne: großer Maßstab dominiert (keine sichtbaren Wiederholungen)
          float far = smoothstep(60.0, 220.0, length(vWXZ - cameraPosition.xz));
          tg = mix(tg, texture2D(tG, ub * 0.35).rgb, far * 0.6); td = mix(td, texture2D(tD, ub * 0.35).rgb, far * 0.6);
          vec3 base = (tg * w.x + td * w.y + tr * w.z + ts * w.w) * 2.0;
          // Farbvariation: trockene, gelbliche Wiesenflecken und satte, dunkle Senken
          float dry = smoothstep(0.55, 0.75, mac);
          base *= mix(vec3(1.0), vec3(1.18, 1.08, 0.78), dry * w.x) * mix(1.0, 0.82, smoothstep(0.42, 0.25, mac) * w.x);
          diffuseColor.rgb *= base;`);
    };
    this.chunkCells = 100;
    const cnum = (this.n - 1) / this.chunkCells;
    this.chunks = [];
    for (let cj = 0; cj < cnum; cj++) for (let ci = 0; ci < cnum; ci++) {
      const ch = { ci, cj, lod: [null, null, null], level: -1 };
      ch.x0 = -this.half + ci * this.chunkCells * this.cell; ch.z0 = -this.half + cj * this.chunkCells * this.cell;
      ch.x1 = ch.x0 + this.chunkCells * this.cell; ch.z1 = ch.z0 + this.chunkCells * this.cell;
      ch.lod[1] = this.makeChunkMesh(ci, cj, 2);
      ch.lod[2] = this.makeChunkMesh(ci, cj, 4);
      ch.lod[1].visible = false; ch.lod[2].visible = true;
      this.group.add(ch.lod[1], ch.lod[2]);
      this.chunks.push(ch);
    }
  },

  makeChunkMesh(ci, cj, step) {
    const { n, cell, half, H, col, lin } = this;
    const per = this.chunkCells, m = per / step, V = m + 3;
    const pos = new Float32Array(V * V * 3), nor = new Float32Array(V * V * 3), clr = new Float32Array(V * V * 3), uv = new Float32Array(V * V * 2);
    const spl = new Uint8Array(V * V * 4), SP = this.splat;
    let k = 0;
    for (let vj = -1; vj <= m + 1; vj++) {
      for (let vi = -1; vi <= m + 1; vi++) {
        const skirt = vi < 0 || vi > m || vj < 0 || vj > m;
        const ii = ci * per + clamp(vi, 0, m) * step, jj = cj * per + clamp(vj, 0, m) * step;
        const idx = jj * n + ii;
        const x = -half + ii * cell, z = -half + jj * cell;
        pos[k * 3] = x; pos[k * 3 + 1] = H[idx] - (skirt ? 6 : 0); pos[k * 3 + 2] = z;
        const s = step;
        const hx = (H[jj * n + Math.min(ii + s, n - 1)] - H[jj * n + Math.max(ii - s, 0)]) / (2 * s * cell);
        const hz = (H[Math.min(jj + s, n - 1) * n + ii] - H[Math.max(jj - s, 0) * n + ii]) / (2 * s * cell);
        const l = Math.hypot(hx, 1, hz);
        nor[k * 3] = -hx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = -hz / l;
        clr[k * 3] = lin[col[idx * 3]]; clr[k * 3 + 1] = lin[col[idx * 3 + 1]]; clr[k * 3 + 2] = lin[col[idx * 3 + 2]];
        uv[k * 2] = x / 14; uv[k * 2 + 1] = z / 14;
        spl[k * 4] = SP[idx * 4]; spl[k * 4 + 1] = SP[idx * 4 + 1]; spl[k * 4 + 2] = SP[idx * 4 + 2]; spl[k * 4 + 3] = SP[idx * 4 + 3];
        k++;
      }
    }
    const index = [];
    for (let j = 0; j < V - 1; j++) for (let i = 0; i < V - 1; i++) {
      const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(clr, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('splat', new THREE.BufferAttribute(spl, 4, true));
    g.setIndex(index);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.terrainMat);
    mesh.receiveShadow = true;
    return mesh;
  },

  buildWater() {
    const L = WORLD.lake;
    this.waterNormal = makeWaterNormal();
    this.waterNormal.repeat.set(60, 60);
    this.waterMat = new THREE.MeshStandardMaterial({
      color: 0x1b4250, roughness: 0.07, metalness: 0.0, transparent: true, opacity: 0.9,
      normalMap: this.waterNormal, normalScale: new THREE.Vector2(0.25, 0.25), envMapIntensity: 0.9,
    });
    // Wassertiefe als Textur (aus dem Höhenfeld): flach = klar türkis mit Uferschaum, tief = dunkel blaugrün
    const DN = 256, depth = new Uint8Array(DN * DN);
    for (let j = 0; j < DN; j++) for (let i = 0; i < DN; i++) {
      const x = L.cx - 600 + (i + 0.5) / DN * 1200, z = L.cz - 600 + (j + 0.5) / DN * 1200;
      depth[j * DN + i] = clamp((this.waterLevel - this.sample(x, z)) / 12, 0, 1) * 255;
    }
    const depthTex = new THREE.DataTexture(depth, DN, DN, THREE.RedFormat); depthTex.magFilter = depthTex.minFilter = THREE.LinearFilter; depthTex.needsUpdate = true;
    this.waterU = { uTime: { value: 0 }, uDepth: { value: depthTex }, uRain: { value: 0 }, uOrigin: { value: new THREE.Vector2(L.cx - 600, L.cz - 600) } };
    const WU = this.waterU;
    this.waterMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, WU);
      sh.vertexShader = 'varying vec2 vWP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vWP = (modelMatrix * vec4(position, 1.0)).xz;');
      sh.fragmentShader = 'uniform float uTime; uniform sampler2D uDepth; uniform float uRain; uniform vec2 uOrigin; varying vec2 vWP;\n' + sh.fragmentShader
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          // zweite, gegenläufige Wellenlage + Regentropfen-Ringe
          { vec3 n2 = texture2D(normalMap, vWP / 9.0 + vec2(-uTime * 0.021, uTime * 0.013)).xyz * 2.0 - 1.0;
            normal = normalize(normal + vec3(n2.xy * 0.22, 0.0));
            if (uRain > 0.02) { vec2 g = vWP * 1.4; vec2 id = floor(g), f = fract(g) - 0.5;
              float ph = fract(uTime * 0.8 + fract(sin(dot(id, vec2(12.9, 78.2))) * 437.5));
              float r = length(f), ring = sin((r - ph * 0.5) * 40.0) * smoothstep(0.5 * ph + 0.05, 0.5 * ph, r) * (1.0 - ph);
              normal = normalize(normal + vec3(f / max(r, 0.01) * ring * 0.35 * uRain, 0.0)); } }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float wd = texture2D(uDepth, (vWP - uOrigin) / 1200.0).r;
          vec3 shallow = vec3(0.07, 0.24, 0.24), deep = vec3(0.012, 0.05, 0.075);
          diffuseColor.rgb = mix(shallow, deep, smoothstep(0.0, 0.18, wd));
          diffuseColor.a = mix(0.7, 0.96, smoothstep(0.0, 0.12, wd));
          // Uferschaum: schmaler, pulsierender Streifen an der Wasserkante
          float foamN = fract(sin(dot(floor(vWP * 3.0), vec2(12.98, 78.23))) * 43758.5);
          float foam = smoothstep(0.02, 0.0, wd) * (0.55 + 0.45 * sin(uTime * 1.7 + vWP.x * 0.6 + vWP.y * 0.4)) * (0.6 + 0.4 * foamN);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 0.95), foam * 0.85); diffuseColor.a = max(diffuseColor.a, foam);`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.6, foam);');
    };
    const water = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), this.waterMat);
    water.rotation.x = -Math.PI / 2; water.position.set(L.cx, this.waterLevel, L.cz);
    water.receiveShadow = true; water.renderOrder = 1;
    this.group.add(water);
  },

  /** Fahrbahnband entlang von Kantenpunkten (UV: quer 0..1, längs in Texturlängen). */
  stripGeometry(edges, halfW, texLen, yOff, trim = 0, filter = null) {
    const pos = [], uv = [], idx = [];
    for (const e of edges) {
      let prev = -1;
      for (let i = 0; i < e.pts.length; i++) {
        const p = e.pts[i];
        if (p.s < trim || p.s > e.len - trim || (filter && !filter(p))) { prev = -1; continue; }
        const rx = -p.tz, rz = p.tx;
        const base = pos.length / 3;
        pos.push(p.x - rx * halfW, p.y + yOff, p.z - rz * halfW, p.x + rx * halfW, p.y + yOff, p.z + rz * halfW);
        uv.push(0, p.s / texLen, 1, p.s / texLen);
        if (prev >= 0) idx.push(prev, prev + 1, base, prev + 1, base + 1, base);   // Oberseite zeigt nach oben
        prev = base;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  },

  buildRoads() {
    this.wetMats = this.wetMats || [];
    const grain = makeGrainTexture();
    const roadMat = (tex) => {
      const bump = grain.clone(); bump.repeat.set(tex.userData.w / 3, tex.userData.len / 3); bump.needsUpdate = true;
      const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0, bumpMap: bump, bumpScale: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
      this.addPuddles(m);
      this.wetMats.push(m); return m;
    };
    const byCls = (c) => this.edges.filter((e) => e.cls === c);
    this.roadTex = { highway: makeRoadTexture('highway'), country: makeRoadTexture('country'), city: makeRoadTexture('city'), runway: makeRoadTexture('runway'), plain: makeRoadTexture('plain') };
    const add = (geo, tex) => { const m = new THREE.Mesh(geo, roadMat(tex)); m.receiveShadow = true; this.group.add(m); return m; };
    add(this.stripGeometry(byCls('highway'), 11, 18, 0.1), this.roadTex.highway);
    add(this.stripGeometry(byCls('country'), 4.2, 18, 0.1), this.roadTex.country);
    add(this.stripGeometry(byCls('city'), 7, 18, 0.06, 7), this.roadTex.city);
    // Startbahn
    const A = WORLD.air;
    const rw = new THREE.PlaneGeometry(60, A.hx * 2);
    const ruv = rw.attributes.uv; for (let i = 0; i < ruv.count; i++) ruv.setY(i, ruv.getY(i) * A.hx * 2 / 50);
    const runway = add(rw, this.roadTex.runway);
    runway.rotation.set(-Math.PI / 2, 0, Math.PI / 2); runway.position.set(A.cx, A.h + 0.05, A.cz);

    // Brücke: Hohlkasten unter der Fahrbahn + Pfeiler + Physik-Segmente
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x9a978f, roughness: 0.85, side: THREE.DoubleSide });
    const pos = [], idx = [];
    const pillars = [];
    for (const e of byCls('highway')) {
      for (let i = 0; i < e.pts.length - 1; i++) {
        const p = e.pts[i], q = e.pts[i + 1];
        if (!p.bridge || !q.bridge) continue;
        // Physik
        const dx = q.x - p.x, dz = q.z - p.z, len2 = dx * dx + dz * dz;
        const seg = { ax: p.x, az: p.z, ay: p.y + 0.1, by: q.y + 0.1, dx, dz, len2, halfW: 11.4, gx: (q.y - p.y) * dx / len2, gz: (q.y - p.y) * dz / len2 };
        this.bridgeHash.insert(Math.min(p.x, q.x) - 12, Math.min(p.z, q.z) - 12, Math.max(p.x, q.x) + 12, Math.max(p.z, q.z) + 12, seg);
        // Kasten: Seitenwände und Boden
        for (const s of [-1, 1]) {
          const ax = p.x - p.tz * 10.6 * s, az = p.z + p.tx * 10.6 * s, bx = q.x - q.tz * 10.6 * s, bz = q.z + q.tx * 10.6 * s;
          const b = pos.length / 3;
          pos.push(ax, p.y + 0.05, az, bx, q.y + 0.05, bz, ax, p.y - 1.9, az, bx, q.y - 1.9, bz);
          if (s < 0) idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); else idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
        const b = pos.length / 3;
        pos.push(p.x - p.tz * 10.6, p.y - 1.9, p.z + p.tx * 10.6, p.x + p.tz * 10.6, p.y - 1.9, p.z - p.tx * 10.6,
                 q.x - q.tz * 10.6, q.y - 1.9, q.z + q.tx * 10.6, q.x + q.tz * 10.6, q.y - 1.9, q.z - q.tx * 10.6);
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        if (i % 10 === 0) for (const s of [-1, 1]) pillars.push([p.x - p.tz * 5.5 * s, p.z + p.tx * 5.5 * s, p.y - 1.9]);
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, deckMat); m.castShadow = true; m.receiveShadow = true; this.group.add(m);
      const pg = new THREE.CylinderGeometry(1.1, 1.3, 1, 12); pg.translate(0, 0.5, 0);
      const pm = new THREE.InstancedMesh(pg, deckMat, pillars.length);
      const mtx = new THREE.Matrix4();
      pillars.forEach(([x, z, top], i) => { const bot = this.sample(x, z) - 2; mtx.makeScale(1, top - bot, 1).setPosition(x, bot, z); pm.setMatrixAt(i, mtx); });
      pm.castShadow = true; this.group.add(pm);
    }
  },

  // ---------- Leitplanken (Autobahn außen + Mittelstreifen) ----------
  buildRails() {
    const railPos = [], railIdx = [], posts = [];
    const addSeg = (ax, az, ay, bx, bz, by) => {
      const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz, l = Math.sqrt(len2) || 1;
      const seg = { ax, az, dx, dz, len2, nx: -dz / l, nz: dx / l, top: Math.max(ay, by) + 0.95 };
      this.barrierHash.insert(Math.min(ax, bx) - 1, Math.min(az, bz) - 1, Math.max(ax, bx) + 1, Math.max(az, bz) + 1, seg);
      const b = railPos.length / 3;
      railPos.push(ax, ay + 0.48, az, bx, by + 0.48, bz, ax, ay + 0.82, az, bx, by + 0.82, bz);
      railIdx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    };
    for (const e of this.edges) {
      if (e.cls !== 'highway') continue;
      for (const off of [-11.3, 0, 11.3]) {
        const gap = off === 0 ? 25 : 55;
        let prev = null;
        for (let i = 0; i < e.pts.length; i++) {
          const p = e.pts[i];
          if (p.s < gap || p.s > e.len - gap) { prev = null; continue; }
          const x = p.x - p.tz * off, z = p.z + p.tx * off, y = p.y + 0.1;
          if (prev) addSeg(prev[0], prev[1], prev[2], x, z, y);
          if (i % 2 === 0) posts.push([x, z, y]);
          prev = [x, z, y];
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(railPos, 3)); g.setIndex(railIdx); g.computeVertexNormals();
    const railMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.75, roughness: 0.35, side: THREE.DoubleSide });
    this.group.add(new THREE.Mesh(g, railMat));
    const pg = new THREE.BoxGeometry(0.1, 0.85, 0.14); pg.translate(0, 0.42, 0);
    const pm = new THREE.InstancedMesh(pg, railMat, posts.length);
    const m = new THREE.Matrix4();
    posts.forEach(([x, z, y], i) => { m.makeTranslation(x, y, z); pm.setMatrixAt(i, m); });
    this.group.add(pm);
  },

  // ---------- Straßenlaternen, Lichtkegel am Boden ----------
  buildLamps() {
    const metal = [0.36, 0.38, 0.4];
    const single = mergeParts([
      { geo: new THREE.CylinderGeometry(0.08, 0.14, 8, 8).translate(0, 4, 0), color: metal },
      { geo: new THREE.BoxGeometry(0.08, 0.08, 1.8).translate(0, 7.9, -0.9), color: metal },
      { geo: new THREE.BoxGeometry(0.46, 0.13, 0.26).translate(0, 7.85, -1.7), color: [0.25, 0.26, 0.27] },
    ]);
    const double = mergeParts([
      { geo: new THREE.CylinderGeometry(0.1, 0.18, 10, 8).translate(0, 5, 0), color: metal },
      { geo: new THREE.BoxGeometry(0.08, 0.08, 4).translate(0, 9.9, 0), color: metal },
      { geo: new THREE.BoxGeometry(0.46, 0.13, 0.26).translate(0, 9.85, -1.9), color: [0.25, 0.26, 0.27] },
      { geo: new THREE.BoxGeometry(0.46, 0.13, 0.26).translate(0, 9.85, 1.9), color: [0.25, 0.26, 0.27] },
    ]);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.45 });
    const ones = this.lamps.filter((l) => l.kind === 1), twos = this.lamps.filter((l) => l.kind === 2);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    for (const [list, geo] of [[ones, single], [twos, double]]) {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((l, i) => { q.setFromAxisAngle(up, l.yaw); m.compose(new THREE.Vector3(l.x, l.y, l.z), q, one); im.setMatrixAt(i, m); });
      im.castShadow = true; this.group.add(im);
    }
    // Leuchtmittel + Lichtpfützen am Boden
    const bulbs = this.lamps.flatMap((l) => l.bulbs);
    this.bulbMat = new THREE.MeshBasicMaterial({ color: 0x555048, toneMapped: false });
    const bm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.38, 0.03, 0.2), this.bulbMat, bulbs.length);
    this.poolMat = new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'), color: 0xffc078, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    const pg = new THREE.PlaneGeometry(19, 19); pg.rotateX(-Math.PI / 2);   // Lichtkegel der Laterne auf Straße und Gehweg
    this.pools = new THREE.InstancedMesh(pg, this.poolMat, bulbs.length);
    bulbs.forEach((b, i) => {
      m.makeTranslation(b[0], b[1] - 0.09, b[2]); bm.setMatrixAt(i, m);
      m.makeTranslation(b[0], this.sample(b[0], b[2]) + 0.14, b[2]); this.pools.setMatrixAt(i, m);
    });
    this.pools.visible = false; this.pools.renderOrder = 2; this.pools.frustumCulled = false;   // Instanzen weit vom Ursprung: nicht per Hüllkugel wegschneiden
    this.group.add(bm, this.pools);
    // Lichthöfe um die Leuchten (nachts): alle Laternen in einem einzigen Punkt-Draw-Call
    const hp = new Float32Array(bulbs.length * 3);
    bulbs.forEach((b, i) => { hp[i * 3] = b[0]; hp[i * 3 + 1] = b[1] - 0.15; hp[i * 3 + 2] = b[2]; });
    const hg = new THREE.BufferGeometry(); hg.setAttribute('position', new THREE.BufferAttribute(hp, 3));
    this.halos = new THREE.Points(hg, new THREE.PointsMaterial({ map: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'), color: 0xffd6a0, size: 4.2,
      sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85, fog: true }));
    this.halos.visible = false; this.halos.frustumCulled = false; this.group.add(this.halos);
    // Echte Lichtquellen für die nächstgelegenen Laternen (nachts, je nach Grafikstufe)
    this.lampLights = [];
    for (let i = 0; i < this.q.lampLights; i++) {
      const pl = new THREE.PointLight(0xffc98f, 0, 34, 1.3);
      this.scene.add(pl); this.lampLights.push(pl);
    }
  },

  // ---------- Stadt ----------
  buildCity() {
    const C = WORLD.city;
    // Boden (Kreuzungen, Ränder) und Gehweg-Blöcke
    const plain = this.roadTex.plain.clone(); plain.needsUpdate = true;
    plain.repeat.set((C.x1 - C.x0 + 28) / 16, (C.z1 - C.z0 + 28) / 16);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(C.x1 - C.x0 + 28, C.z1 - C.z0 + 28),
      new THREE.MeshStandardMaterial({ map: plain, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(C.cx, C.h + 0.03, C.cz); ground.receiveShadow = true;
    this.wetMats.push(ground.material);
    this.group.add(ground);
    const slabMat = new THREE.MeshStandardMaterial({ map: makePavingTexture(), roughness: 0.88 });
    // Plattenmuster in Weltkoordinaten (gleich große Platten auf jedem Block)
    slabMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n vec4 pwp = modelMatrix * instanceMatrix * vec4(position, 1.0); vMapUv = pwp.xz / 3.0;');
    };
    this.wetMats.push(slabMat);
    const slab = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), slabMat, this.blocks.length);
    const m = new THREE.Matrix4(), col = new THREE.Color();
    this.blocks.forEach((b, i) => {
      m.makeScale(b.x1 - b.x0 + 8, 0.12, b.z1 - b.z0 + 8).setPosition((b.x0 + b.x1) / 2, C.h + 0.06, (b.z0 + b.z1) / 2);
      slab.setMatrixAt(i, m);
      slab.setColorAt(i, b.park ? col.setRGB(0.33, 0.5, 0.2) : col.setRGB(1, 1, 1));
    });
    slab.receiveShadow = true; this.group.add(slab);

    // Gebäude mit Fassaden-Shader (Fenster in Weltkoordinaten → passt zu jeder Größe)
    this.windowGlow = { value: 0 };
    const facadeMat = (kind) => {
      const t = makeFacadeTextures(kind);
      const mat = new THREE.MeshStandardMaterial({
        map: t.map, emissiveMap: t.emissive, emissive: 0xffffff, emissiveIntensity: 1,
        roughness: kind === 0 ? 0.55 : 0.88, metalness: 0.0, envMapIntensity: kind === 0 ? 1.7 : 1.2,
      });
      const glow = this.windowGlow;
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uGlow = glow;
        sh.vertexShader = 'varying vec2 vFac; varying float vRoof; varying float vAO; varying float vHA; varying float vSeed; varying vec3 vFW; varying vec3 vFN;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          mat4 fm = modelMatrix * instanceMatrix;
          vec4 fwp = fm * vec4(position, 1.0);
          vec3 fwn = normalize(mat3(fm) * normal);
          float fseed = fract(sin(dot(fm[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
          vFac = (abs(fwn.x) > 0.5 ? vec2(fwp.z, fwp.y) : vec2(fwp.x, fwp.y)) / 28.0 + vec2(floor(fseed * 8.0) / 8.0, floor(fract(fseed * 13.0) * 8.0) / 8.0);
          vRoof = fwn.y;
          vAO = 0.55 + 0.45 * smoothstep(0.0, 4.5, fwp.y - fm[3].y);
          vHA = fwp.y - fm[3].y; vSeed = fseed; vFW = fwp.xyz; vFN = fwn;`);
        sh.fragmentShader = 'uniform float uGlow; varying vec2 vFac; varying float vRoof; varying float vAO; varying float vHA; varying float vSeed; varying vec3 vFW; varying vec3 vFN;\n' + sh.fragmentShader
          .replace('#include <map_fragment>', 'vec4 facCol = texture2D(map, vFac);' +
            // Parallaxe: Fensterscheibe liegt ~25 cm hinter der Fassade → seitlich sichtbare Laibung (Schattenkante)
            ' { vec3 V = normalize(cameraPosition - vFW); float vn = max(abs(dot(V, vFN)), 0.25);' +
            '   vec2 vd = abs(vFN.x) > 0.5 ? vec2(V.z, V.y) : vec2(V.x, V.y);' +
            '   vec4 inner = texture2D(map, vFac - vd / vn * (0.25 / 28.0));' +
            '   float gHere = 1.0 - smoothstep(0.06, 0.2, dot(facCol.rgb, vec3(0.299, 0.587, 0.114)));' +
            '   float gIn = 1.0 - smoothstep(0.06, 0.2, dot(inner.rgb, vec3(0.299, 0.587, 0.114)));' +
            '   if (vRoof < 0.5 && gHere > 0.5 && gIn < 0.5) facCol.rgb = inner.rgb * 0.45; }' +
            ' if (vRoof > 0.5) facCol = vec4(vec3(0.3, 0.3, 0.31), 1.0); diffuseColor *= facCol;' +
            // Erdgeschoss: Ladenzeile mit großen Schaufenstern und farbigem Schild
            ' float shop = (1.0 - step(0.5, vRoof)) * (1.0 - step(4.2, vHA)); float bay = fract(vFac.x * 7.0);' +
            ' float glassZ = step(0.35, vHA) * step(vHA, 3.05) * step(0.07, bay) * step(bay, 0.93); float signZ = step(3.3, vHA) * step(vHA, 3.95) * step(0.03, bay) * step(bay, 0.97);' +
            ' vec3 signCol = vec3(fract(vSeed * 7.13), fract(vSeed * 3.71), fract(vSeed * 5.37)) * 0.75 + 0.15;' +
            ' if (shop > 0.5) { diffuseColor.rgb = mix(vec3(0.42, 0.4, 0.38), vec3(0.05, 0.065, 0.08), glassZ); diffuseColor.rgb = mix(diffuseColor.rgb, signCol, signZ); }' +
            ' diffuseColor.rgb *= vAO;' +
            // Fensterflächen: glatt (spiegeln Himmel und Nachbarhäuser, v. a. im flachen Winkel)
            ' float winMask = (1.0 - smoothstep(0.06, 0.2, dot(facCol.rgb, vec3(0.299, 0.587, 0.114)))) * (1.0 - step(0.5, vRoof));' +
            ' if (shop > 0.5) winMask = glassZ;')
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.04, winMask);')
          .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = mix(metalnessFactor, 0.0, winMask);')
          .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= texture2D(emissiveMap, vFac).rgb * uGlow * (1.0 - step(0.5, vRoof)); float shopLit = step(0.45, fract(sin(floor(vFac.x * 7.0) * 12.9898 + vSeed * 78.233) * 43758.5453)); if (shop > 0.5) totalEmissiveRadiance = (glassZ * shopLit * vec3(1.0, 0.8, 0.55) * 0.45 + signZ * signCol * 1.1) * uGlow;');
      };
      return mat;
    };
    const unit = new THREE.BoxGeometry(1, 1, 1); unit.translate(0, 0.5, 0);
    const offices = this.buildings.filter((b) => b.kind === 0), others = this.buildings.filter((b) => b.kind !== 0);
    const glassPal = [[0.82, 0.88, 0.95], [1.0, 0.86, 0.68], [0.8, 0.95, 0.88], [0.95, 0.95, 0.95], [0.72, 0.78, 0.9]];
    const pal = [[0.95, 0.92, 0.86], [0.86, 0.78, 0.68], [0.78, 0.55, 0.45], [0.7, 0.72, 0.74], [0.93, 0.9, 0.78], [0.62, 0.66, 0.7]];
    for (const [list, kind] of [[offices, 0], [others, 1]]) {
      const im = new THREE.InstancedMesh(unit, facadeMat(kind), list.length);
      list.forEach((b, i) => {
        m.makeScale(b.x1 - b.x0, b.h, b.z1 - b.z0).setPosition((b.x0 + b.x1) / 2, b.y0, (b.z0 + b.z1) / 2);
        im.setMatrixAt(i, m);
        if (kind === 0) { const gp = glassPal[Math.floor(b.tint * glassPal.length)]; col.setRGB(gp[0], gp[1], gp[2]); }
        else if (b.kind === 2) col.setRGB(0.8, 0.82, 0.84);
        else { const p = pal[Math.floor(b.tint * pal.length)]; col.setRGB(p[0], p[1], p[2]); }
        im.setColorAt(i, col);
      });
      im.castShadow = true; im.receiveShadow = true;
      this.group.add(im);
    }
    // Attika (Dachrand) und Gesims: ein Kranz knapp über/unter der Dachkante
    const cm = new THREE.InstancedMesh(unit, new THREE.MeshStandardMaterial({ color: 0x9a9894, roughness: 0.8 }), this.buildings.length * 2);
    this.buildings.forEach((b, i) => {
      m.makeScale(b.x1 - b.x0 + 0.5, 0.9, b.z1 - b.z0 + 0.5).setPosition((b.x0 + b.x1) / 2, b.top - 0.2, (b.z0 + b.z1) / 2); cm.setMatrixAt(i * 2, m);
      m.makeScale(b.x1 - b.x0 + 0.3, 0.35, b.z1 - b.z0 + 0.3).setPosition((b.x0 + b.x1) / 2, b.y0 + 4.2, (b.z0 + b.z1) / 2); cm.setMatrixAt(i * 2 + 1, m);
    });
    cm.castShadow = true; cm.receiveShadow = true; this.group.add(cm);
    // Dachaufbauten (Lüftung, Technik)
    const rng = mulberry32(77), units = [];
    for (const b of this.buildings) {
      const k = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < k; i++) {
        const w = 2 + rng() * 3, d = 2 + rng() * 3;
        if (b.x1 - b.x0 < w + 2 || b.z1 - b.z0 < d + 2) continue;
        units.push([lerp(b.x0 + w / 2 + 1, b.x1 - w / 2 - 1, rng()), b.top, lerp(b.z0 + d / 2 + 1, b.z1 - d / 2 - 1, rng()), w, 1 + rng() * 1.5, d]);
      }
    }
    const um = new THREE.InstancedMesh(unit, new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.7, metalness: 0.3 }), units.length);
    units.forEach(([x, y, z, w, h, d], i) => { m.makeScale(w, h, d).setPosition(x, y, z); um.setMatrixAt(i, m); });
    um.castShadow = true; this.group.add(um);

    // ---------- Dachlandschaft, Leuchtreklame, Haltestellen, Baustelle ----------
    {
      const rng3 = mulberry32(9090), tanks = [], ants = [], signs = [], stops = [];
      for (const b of this.buildings) {
        const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
        if (b.kind === 1 && rng3() < 0.45) tanks.push([lerp(b.x0 + 3, b.x1 - 3, rng3()), b.top, lerp(b.z0 + 3, b.z1 - 3, rng3())]);      // Wassertank auf Stelzen
        if (b.h > 30 && rng3() < 0.6) ants.push([cx + (rng3() - 0.5) * 4, b.top, cz + (rng3() - 0.5) * 4, 6 + rng3() * 12]);            // Antennenmast
        if (b.y0 === C.h && b.kind !== 2 && rng3() < 0.35) {                                                                           // Leuchtreklame an der Fassade
          const side = Math.floor(rng3() * 4), nx = [0, 0, -1, 1][side], nz = [-1, 1, 0, 0][side];
          const fx = nx ? (nx < 0 ? b.x0 : b.x1) : cx, fz = nz ? (nz < 0 ? b.z0 : b.z1) : cz;
          signs.push({ x: fx + nx * 0.35, z: fz + nz * 0.35, y: C.h + 5.5 + rng3() * Math.min(12, b.h - 8), yaw: Math.atan2(nx, nz), w: 3 + rng3() * 4, k: Math.floor(rng3() * 6) });
        }
      }
      for (const e of this.edges) if (e.cls === 'city' && rng3() < 0.4) {
        const pnt = this.pointOnEdge(e, e.len * 0.5), sd = rng3() < 0.5 ? -1 : 1;
        stops.push([pnt.x - pnt.tz * sd * (C.streetHalf + 2.2), pnt.z + pnt.tx * sd * (C.streetHalf + 2.2), Math.atan2(-pnt.tz * sd, pnt.tx * sd)]);
      }
      const mk = (geo, mat, list, fn) => { const im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length)); list.forEach((it, i) => { fn(it); im.setMatrixAt(i, m); }); im.count = list.length; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false; this.group.add(im); return im; };
      const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 });
      const tankGeo = mergeParts([
        { geo: new THREE.CylinderGeometry(1.6, 1.6, 3, 14).translate(0, 4.3, 0), color: [0.42, 0.33, 0.25] },
        { geo: new THREE.ConeGeometry(1.75, 0.9, 14).translate(0, 6.25, 0), color: [0.3, 0.27, 0.24] },
        ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a2, b2]) => ({ geo: new THREE.CylinderGeometry(0.08, 0.08, 2.8, 6).translate(a2 * 1.1, 1.4, b2 * 1.1), color: [0.2, 0.2, 0.22] })),
      ]);
      mk(tankGeo, metal, tanks, (t) => m.makeTranslation(t[0], t[1], t[2]));
      const antGeo = mergeParts([
        { geo: new THREE.CylinderGeometry(0.06, 0.12, 1, 6).translate(0, 0.5, 0), color: [0.55, 0.56, 0.58] },
        { geo: new THREE.BoxGeometry(1.6, 0.04, 0.04).translate(0, 0.75, 0), color: [0.55, 0.56, 0.58] },
        { geo: new THREE.BoxGeometry(1.0, 0.04, 0.04).translate(0, 0.88, 0), color: [0.55, 0.56, 0.58] },
      ]);
      mk(antGeo, metal, ants, (a2) => m.makeScale(1, a2[3], 1).setPosition(a2[0], a2[1], a2[2]));
      // Leuchtreklame: farbige, nachts leuchtende Tafeln (Fantasie-Schriftzüge)
      const signTex = (() => {
        const cv = document.createElement('canvas'); cv.width = 512; cv.height = 384; const c = cv.getContext('2d');
        const names = [['NOVA', '#ff3b6b'], ['CAFÉ LUNA', '#ffd24a'], ['HOTEL', '#4af0ff'], ['APOTHEKE', '#3dff7a'], ['PIZZA', '#ff8a2b'], ['KINO', '#c96bff']];
        names.forEach(([t, col], i) => { const y = i * 64; c.fillStyle = '#0b0d12'; c.fillRect(0, y, 512, 64); c.strokeStyle = col; c.lineWidth = 4; c.strokeRect(6, y + 6, 500, 52);
          c.fillStyle = col; c.font = 'bold 40px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(t, 256, y + 34); });
        const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
      })();
      this.signMat = new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.5 });
      const signGeo = new THREE.PlaneGeometry(1, 1);
      const sm = new THREE.InstancedMesh(signGeo, this.signMat, Math.max(1, signs.length));
      const sq = new THREE.Quaternion(), sv = new THREE.Vector3(), ss = new THREE.Vector3();
      signs.forEach((g2, i) => { sq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), g2.yaw); m.compose(sv.set(g2.x, g2.y, g2.z), sq, ss.set(g2.w, g2.w / 8 * 1.0, 1)); sm.setMatrixAt(i, m); });
      // Textur-Zeile je Schild: UV-Offset über Instanz-Attribut
      const rowA = new Float32Array(Math.max(1, signs.length)); signs.forEach((g2, i) => { rowA[i] = g2.k; });
      signGeo.setAttribute('row', new THREE.InstancedBufferAttribute(rowA, 1));
      this.signMat.onBeforeCompile = (sh) => { sh.vertexShader = 'attribute float row;\n' + sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n vMapUv = vec2(vMapUv.x, (5.0 - row + vMapUv.y) / 6.0); vEmissiveMapUv = vMapUv;'); };
      sm.count = signs.length; sm.frustumCulled = false; this.group.add(sm);
      // Bushaltestelle: Wartehäuschen aus Glas mit Dach und Werbevitrine
      const stopGeo = mergeParts([
        { geo: new THREE.BoxGeometry(3.6, 0.08, 1.5).translate(0, 2.5, 0), color: [0.25, 0.27, 0.3] },
        { geo: new THREE.BoxGeometry(3.6, 2.3, 0.05).translate(0, 1.25, -0.7), color: [0.55, 0.65, 0.7] },
        { geo: new THREE.BoxGeometry(0.05, 2.3, 1.4).translate(1.78, 1.25, 0), color: [0.95, 0.9, 0.75] },
        { geo: new THREE.BoxGeometry(0.08, 2.5, 0.08).translate(-1.75, 1.25, 0.68), color: [0.25, 0.27, 0.3] },
        { geo: new THREE.BoxGeometry(2.4, 0.08, 0.4).translate(-0.3, 0.5, -0.45), color: [0.4, 0.3, 0.2] },
        { geo: new THREE.CylinderGeometry(0.05, 0.05, 2.9, 6).translate(2.3, 1.45, 0.6), color: [0.3, 0.3, 0.32] },
        { geo: new THREE.CylinderGeometry(0.28, 0.28, 0.04, 16).rotateX(Math.PI / 2).translate(2.3, 2.75, 0.6), color: [0.95, 0.8, 0.1] },
      ]);
      mk(stopGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.3, transparent: true, opacity: 0.92 }), stops, (st) => m.makeRotationY(st[2]).setPosition(st[0], C.h + 0.12, st[1]));
      // Baustelle mit Turmdrehkran (in einem freien Park-/Baublock)
      const site = this.blocks.find((b) => b.park) || this.blocks[3];
      if (site) {
        const kx = (site.x0 + site.x1) / 2, kz = (site.z0 + site.z1) / 2, yel = [0.95, 0.72, 0.08];
        const parts = [];
        for (let k = 0; k < 14; k++) parts.push({ geo: new THREE.BoxGeometry(1.6, 4, 1.6).translate(0, 2 + k * 4, 0), color: yel });
        parts.push({ geo: new THREE.BoxGeometry(48, 1.4, 1.4).translate(14, 57, 0), color: yel });
        parts.push({ geo: new THREE.BoxGeometry(6, 3, 2.4).translate(-9, 55.5, 0), color: [0.6, 0.6, 0.62] });              // Gegengewicht
        parts.push({ geo: new THREE.BoxGeometry(3, 2.5, 2.4).translate(0, 54.5, 0), color: [0.85, 0.85, 0.8] });            // Führerhaus
        parts.push({ geo: new THREE.CylinderGeometry(0.04, 0.04, 30, 4).translate(30, 41.5, 0), color: [0.1, 0.1, 0.1] }); // Seil
        parts.push({ geo: new THREE.BoxGeometry(3, 1.2, 1.2).translate(30, 26, 0), color: [0.45, 0.45, 0.47] });         // Last
        parts.push({ geo: new THREE.BoxGeometry(site.x1 - site.x0 - 6, 2, 0.15).translate(0, 1, (site.z1 - site.z0) / 2 - 3), color: [0.85, 0.85, 0.85] });  // Bauzaun
        const crane = new THREE.Mesh(mergeParts(parts), metal); crane.position.set(kx, C.h, kz); crane.castShadow = true; this.group.add(crane);
        this.craneRig = crane;
      }
    }

    // Markisen über Ladenzeilen und Balkone an Wohnhäusern
    {
      const rng2 = mulberry32(4711), awn = [], bal = [];
      const awnCols = [[0.55, 0.1, 0.1], [0.12, 0.3, 0.2], [0.15, 0.2, 0.4], [0.75, 0.6, 0.3], [0.25, 0.25, 0.27], [0.6, 0.35, 0.15]];
      for (const b of this.buildings) {
        if (b.y0 !== C.h || b.kind === 2) continue;
        const sides = [[0, -1, b.x1 - b.x0], [0, 1, b.x1 - b.x0], [-1, 0, b.z1 - b.z0], [1, 0, b.z1 - b.z0]];
        for (const [nx, nz, len] of sides) {
          const cx = nx ? (nx < 0 ? b.x0 : b.x1) : (b.x0 + b.x1) / 2, cz = nz ? (nz < 0 ? b.z0 : b.z1) : (b.z0 + b.z1) / 2;
          if (rng2() < 0.45) {
            const l = len * (0.3 + rng2() * 0.4), off = (rng2() - 0.5) * (len - l);
            awn.push({ x: cx + nx * 0.7 + (nz ? off : 0), z: cz + nz * 0.7 + (nx ? off : 0), y: C.h + 3.35, l, nx, nz, col: awnCols[Math.floor(rng2() * awnCols.length)] });
          }
          if (b.kind === 1 && b.h > 12 && rng2() < 0.6) {
            for (let fy = 7.2; fy < b.h - 2.5 && bal.length < 2600; fy += 3.5) {
              for (let t = 4; t < len - 4; t += 7) bal.push({ x: cx + nx * 0.6 + (nz ? t - len / 2 : 0), z: cz + nz * 0.6 + (nx ? t - len / 2 : 0), y: C.h + fy, nx, nz });
            }
          }
        }
      }
      const am = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.08, 1.4), new THREE.MeshStandardMaterial({ roughness: 0.9 }), Math.max(1, awn.length));
      const cc = new THREE.Color(), dq = new THREE.Quaternion(), de = new THREE.Euler();
      awn.forEach((a, i) => {
        // entlang der Fassade ausgerichtet, nach außen um 14° abfallend
        de.set(0.25, Math.atan2(a.nx, a.nz), 0, 'YXZ'); dq.setFromEuler(de);   // lokale +z zeigt nach außen, Außenkante tiefer
        m.compose(new THREE.Vector3(a.x, a.y, a.z), dq, new THREE.Vector3(a.l, 1, 1));
        am.setMatrixAt(i, m); am.setColorAt(i, cc.setRGB(...a.col, THREE.SRGBColorSpace));
      });
      am.castShadow = true; am.receiveShadow = true; this.group.add(am);
      // Balkon: Bodenplatte + Glasbrüstung (eine Geometrie, Brüstung über Vertexfarbe dunkler)
      const balGeo = mergeParts([
        { geo: new THREE.BoxGeometry(2.6, 0.16, 1.1).translate(0, 0, 0.55), color: [0.85, 0.84, 0.8] },
        { geo: new THREE.BoxGeometry(2.6, 0.95, 0.04).translate(0, 0.55, 1.08), color: [0.35, 0.42, 0.48] },
        { geo: new THREE.BoxGeometry(0.04, 0.95, 1.1).translate(-1.28, 0.55, 0.55), color: [0.35, 0.42, 0.48] },
        { geo: new THREE.BoxGeometry(0.04, 0.95, 1.1).translate(1.28, 0.55, 0.55), color: [0.35, 0.42, 0.48] },
        { geo: new THREE.BoxGeometry(2.64, 0.05, 0.06).translate(0, 1.03, 1.08), color: [0.2, 0.2, 0.22] },
      ]);
      const bm = new THREE.InstancedMesh(balGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 }), Math.max(1, bal.length));
      bal.forEach((b, i) => { dq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(b.nx, b.nz)); m.compose(new THREE.Vector3(b.x, b.y, b.z), dq, new THREE.Vector3(1, 1, 1)); bm.setMatrixAt(i, m); });
      bm.castShadow = true; bm.receiveShadow = true; this.group.add(bm);
    }

    // Ampeln
    const dummy = new THREE.Object3D();
    const poleM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.09, 4.4, 8).translate(0, 2.2, 0), new THREE.MeshStandardMaterial({ color: 0x2b2e31, metalness: 0.5, roughness: 0.5 }), this.heads.length);
    const housing = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.98, 0.26), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 }), this.heads.length);
    this.sigLamps = ['R', 'Y', 'G'].map(() => {
      const im = new THREE.InstancedMesh(new THREE.CircleGeometry(0.1, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), this.heads.length);
      this.group.add(im); return im;
    });
    this.heads.forEach((h, i) => {
      dummy.position.set(h.x, C.h, h.z); dummy.rotation.set(0, h.yaw, 0); dummy.updateMatrix();
      poleM.setMatrixAt(i, dummy.matrix);
      dummy.position.y = C.h + 4.0; dummy.updateMatrix(); housing.setMatrixAt(i, dummy.matrix);
      ['R', 'Y', 'G'].forEach((c, k) => {
        dummy.position.set(h.x, C.h + 4.0 + 0.3 - k * 0.3, h.z); dummy.rotation.set(0, h.yaw, 0);
        dummy.translateZ(0.135); dummy.updateMatrix();
        this.sigLamps[k].setMatrixAt(i, dummy.matrix);
      });
    });
    poleM.castShadow = true; this.group.add(poleM, housing);
    this.updateSignals(true);

    // Zebrastreifen + Haltelinien
    const bars = [];
    for (const c of this.crossings) {
      for (let k = -4; k <= 4; k++) {
        const o = k * 1.4;
        if (c.along === 'z') bars.push([c.x, c.z + o, 3.2, 0.6]); else bars.push([c.x + o, c.z, 0.6, 3.2]);
      }
      const s = c.stop;
      if (s.along === 'z') bars.push([s.x, s.z, 0.4, 4.6]); else bars.push([s.x, s.z, 4.6, 0.4]);
    }
    const bg = new THREE.PlaneGeometry(1, 1); bg.rotateX(-Math.PI / 2);
    const bmesh = new THREE.InstancedMesh(bg, new THREE.MeshStandardMaterial({ color: 0xdedcd4, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -6 }), bars.length);
    bars.forEach(([x, z, sx, sz], i) => { m.makeScale(sx, 1, sz).setPosition(x, C.h + 0.07, z); bmesh.setMatrixAt(i, m); });
    bmesh.receiveShadow = true; this.group.add(bmesh);
  },

  updateSignals(force) {
    const on = { R: [2.6, 0.12, 0.08], Y: [2.6, 1.5, 0.05], G: [0.15, 2.4, 0.9] };
    const off = { R: [0.12, 0.02, 0.02], Y: [0.12, 0.09, 0.02], G: [0.02, 0.1, 0.05] };
    const c = new THREE.Color();
    this.heads.forEach((h, i) => {
      const st = this.signalState(h.node, h.axis);
      ['R', 'Y', 'G'].forEach((k, j) => { const v = st === k ? on[k] : off[k]; this.sigLamps[j].setColorAt(i, c.setRGB(v[0], v[1], v[2])); });
    });
    for (const im of this.sigLamps) if (im.instanceColor) im.instanceColor.needsUpdate = true;
  },

  // ---------- Wald: 2 Baumarten × 2 Detailstufen, Kachel-Culling ----------
  buildTrees() {
    const rng = mulberry32(5);
    // Textur-Atlas: Rinde | dichtes Laub (opak) | Blätterbüschel (Alpha) | Nadelzweige (Alpha, zackiger Rand)
    const A = makeFoliageAtlas();
    const remap = (g, u0, u1, v0, v1) => {
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
      return g;
    };
    const BARK = [0, 0.1875, 0.5, 1], DENSE = [0, 0.1875, 0, 0.5], LEAF = [0.2, 0.6, 0, 1], NEEDLE = [0.61, 1, 0, 1];
    const bark = (g) => remap(g, ...BARK), dense = (g) => remap(g, ...DENSE);
    /** Normalen kugelförmig vom Kronenmittelpunkt aus → weiche, glaubwürdige Beleuchtung des Laubs. */
    const sphereNormals = (g, cx, cy, cz, upBias = 0.35) => {
      const p = g.attributes.position, n = g.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        let x = p.getX(i) - cx, y = p.getY(i) - cy + upBias * 3, z = p.getZ(i) - cz; const l = Math.hypot(x, y, z) || 1;
        n.setXYZ(i, x / l, y / l, z / l);
      }
      return g;
    };
    const GREY = (a, b, y0, y1) => (g) => gradientColors(g, [a, a, a], [b, b, b], y0, y1);
    // --- Laubbaum (nah): Stamm, Äste, dunkler Kern + Blätterkarten rundherum ---
    const decParts = [
      { geo: GREY(0.8, 1, 0, 5)(bark(new THREE.CylinderGeometry(0.2, 0.36, 5.2, 7).translate(0, 2.6, 0))) },
      { geo: GREY(0.8, 1, 4, 7)(bark(new THREE.CylinderGeometry(0.06, 0.14, 2.8, 5).rotateZ(0.75).translate(0.9, 4.9, 0))) },
      { geo: GREY(0.8, 1, 4, 7)(bark(new THREE.CylinderGeometry(0.06, 0.13, 2.6, 5).rotateZ(-0.7).rotateY(2).translate(-0.6, 5.0, -0.6))) },
      { geo: GREY(0.45, 0.8, 4.5, 9.5)(sphereNormals(dense(jitter(new THREE.IcosahedronGeometry(2.5, 1).scale(1.15, 0.95, 1.15).translate(0, 7, 0), 0.7, rng)), 0, 7, 0)) },
    ];
    for (let k = 0; k < 24; k++) {          // mehr, kleinere Blätterkarten → dichtere, weichere Krone
      const th = rng() * Math.PI * 2, ph = Math.acos(rng() * 1.6 - 0.65), r = 2.4 + rng() * 1.0;
      const c = new THREE.Vector3(Math.sin(ph) * Math.cos(th) * r * 1.15, 7 + Math.cos(ph) * r * 0.95, Math.sin(ph) * Math.sin(th) * r * 1.15);
      const size = 2.6 + rng() * 1.4;
      const g = remap(new THREE.PlaneGeometry(size, size), ...LEAF);
      const o = new THREE.Object3D(); o.position.copy(c); o.lookAt(c.clone().multiplyScalar(2).setY(c.y * 2 - 7)); o.rotateZ(rng() * Math.PI); o.updateMatrix();
      g.applyMatrix4(o.matrix);
      decParts.push({ geo: GREY(0.62, 1.05, 4.5, 10)(sphereNormals(g, 0, 7, 0)) });
    }
    const decNear = mergeUV(decParts);
    // --- Nadelbaum (nah): Stamm, dunkler Kern, 6 Lagen Nadelzweige mit zackigem Rand ---
    const conParts = [
      { geo: GREY(0.8, 1, 0, 4)(bark(new THREE.CylinderGeometry(0.15, 0.3, 4, 7).translate(0, 2, 0))) },
      { geo: GREY(0.35, 0.7, 2, 14)(dense(new THREE.ConeGeometry(1.7, 11, 8).translate(0, 8.4, 0))) },
    ];
    for (let k = 0; k < 6; k++) {
      const r = 3.1 - k * 0.47, h = 3.4 - k * 0.28, y = 2.4 + k * 1.95;
      const g = remap(new THREE.ConeGeometry(r, h, 12, 1, true).translate(0, y + h / 2, 0), ...NEEDLE);
      jitter(g, 0.35, rng);
      conParts.push({ geo: GREY(0.5, 1.0, y, y + h)(sphereNormals(g, 0, y + h * 0.3, 0, 0.6)) });
    }
    const conNear = mergeUV(conParts);
    // --- Ferne Detailstufe: wenige, geschlossene Formen ---
    const conFar = mergeUV([
      { geo: GREY(0.8, 1, 0, 3)(bark(new THREE.CylinderGeometry(0.2, 0.3, 2.6, 5).translate(0, 1.3, 0))) },
      { geo: GREY(0.42, 0.85, 2.4, 13)(dense(new THREE.ConeGeometry(3.0, 11, 7).translate(0, 7.6, 0))) },
    ]);
    const decFar = mergeUV([
      { geo: GREY(0.8, 1, 0, 5)(bark(new THREE.CylinderGeometry(0.22, 0.32, 4.6, 5).translate(0, 2.3, 0))) },
      { geo: GREY(0.5, 0.95, 3.5, 10.5)(sphereNormals(dense(jitter(new THREE.IcosahedronGeometry(3.7, 1).scale(1.1, 0.9, 1.1).translate(0, 7, 0), 0.6, rng)), 0, 7, 0)) },
    ]);
    const mat = new THREE.MeshStandardMaterial({ map: A, vertexColors: true, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.88, metalness: 0 });
    this.treeMat = mat;
    this.windT = { value: 0 };
    const windT = this.windT;
    this.treeSun = { value: new THREE.Vector3(0, 1, 0) };      // Sonnenrichtung im Kameraraum (pro Bild gesetzt)
    const treeSun = this.treeSun;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWind = windT; sh.uniforms.uSunV = treeSun;
      // Durchscheinen (Subsurface): Laub leuchtet gelbgrün, wenn man gegen die Sonne durch die Blätter schaut
      sh.fragmentShader = 'uniform vec3 uSunV;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        { float leaf = 1.0 - step(vMapUv.x, 0.19) * step(0.5, vMapUv.y);
          float back = pow(max(dot(normalize(-vViewPosition), uSunV), 0.0), 5.0);
          totalEmissiveRadiance += diffuseColor.rgb * vec3(0.85, 1.0, 0.45) * back * 0.9 * leaf; }`);
      sh.vertexShader = 'uniform float uWind;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 tp = instanceMatrix[3].xyz;
          float sw = max(position.y - 2.5, 0.0);
          float ph = uWind * 1.25 + tp.x * 0.13 + tp.z * 0.17;
          transformed.x += (sin(ph) + 0.4 * sin(ph * 2.3 + 1.0)) * 0.026 * sw;
          transformed.z += cos(ph * 0.8) * 0.018 * sw;
          // Blätter flattern zusätzlich schnell und klein (nur oben in der Krone)
          float fl = step(4.2, position.y) * 0.035;
          transformed.x += sin(uWind * 7.0 + position.x * 3.1 + position.z * 2.3 + tp.x) * fl;
          transformed.y += sin(uWind * 6.3 + position.z * 2.7 + tp.z) * fl * 0.6;
        #endif`);
    };
    const T = this.trees, N = T.count;
    const cap = [0, 0]; for (let i = 0; i < N; i++) cap[T.t[i]]++;
    const mk = (geo, t, shadow) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(cap[t], 1));
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, new THREE.Color(1, 1, 1)); im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      im.count = 0; im.frustumCulled = false; im.castShadow = shadow; im.receiveShadow = true;
      this.group.add(im); return im;
    };
    const shadows = this.q.shadows;
    this.treeNear = [mk(conNear, 0, shadows), mk(decNear, 1, shadows)];
    this.treeFar = [mk(conFar, 0, false), mk(decFar, 1, false)];
    // Matrizen und Farben vorberechnen, in 200-m-Kacheln einsortieren
    this.treeM = new Float32Array(N * 16); this.treeC = new Float32Array(N * 3);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), s = new THREE.Vector3();
    const CS = 200, cn = Math.ceil(this.half * 2 / CS);
    this.treeChunks = [];
    for (let i = 0; i < cn * cn; i++) this.treeChunks.push({ lists: [[], []], box: new THREE.Box3(new THREE.Vector3(1e9, 1e9, 1e9), new THREE.Vector3(-1e9, -1e9, -1e9)), cx: 0, cz: 0 });
    for (let i = 0; i < N; i++) {
      const sc = T.s[i];
      q.setFromAxisAngle(up, T.r[i]); p.set(T.x[i], T.y[i], T.z[i]); s.set(sc, sc * (0.9 + (T.c[i] - 0.82) * 0.7), sc);
      m.compose(p, q, s); m.toArray(this.treeM, i * 16);
      const c = T.c[i];
      // Mischwald: Laubbäume in mehreren Grüntönen (Buche hell, Eiche dunkel, Birke gelbgrün), vereinzelt erstes Herbstlaub;
      // Nadelbäume blaugrün bis dunkel. Kleine Ortsabhängigkeit, damit Bestände zusammengehören.
      { const hsh = Math.abs(Math.sin(T.x[i] * 12.9898 + T.z[i] * 78.233) * 43758.5453) % 1, patch = Math.sin(T.x[i] * 0.013) * Math.cos(T.z[i] * 0.011) * 0.5 + 0.5;
        let r = c, g = c, b = c * 0.9;
        if (T.t[i]) {
          const k = (hsh + patch * 0.5) % 1;
          if (k < 0.3) { r *= 1.08; g *= 1.12; b *= 0.75; }          // hellgrün (Buche/Birke)
          else if (k < 0.75) { r *= 0.9; g *= 0.95; b *= 0.85; }     // sattgrün (Eiche)
          else if (k < 0.92) { r *= 1.15; g *= 1.08; b *= 0.6; }     // gelbgrün
          else { r *= 1.5; g *= 0.95; b *= 0.5; }                    // erste Herbstfärbung
        } else { r *= 0.85 + hsh * 0.15; g *= 0.95 + hsh * 0.1; b *= 0.95 + patch * 0.15; }
        this.treeC[i * 3] = r; this.treeC[i * 3 + 1] = g; this.treeC[i * 3 + 2] = b; }
      const ci = clamp(Math.floor((T.x[i] + this.half) / CS), 0, cn - 1), cj = clamp(Math.floor((T.z[i] + this.half) / CS), 0, cn - 1);
      const ch = this.treeChunks[cj * cn + ci];
      ch.lists[T.t[i]].push(i);
      ch.box.expandByPoint(p.set(T.x[i], T.y[i] - 1, T.z[i])); ch.box.expandByPoint(p.set(T.x[i], T.y[i] + 22 * sc, T.z[i]));
    }
    this.treeChunks = this.treeChunks.filter((c) => c.lists[0].length + c.lists[1].length > 0);
    for (const c of this.treeChunks) { c.cx = (c.box.min.x + c.box.max.x) / 2; c.cz = (c.box.min.z + c.box.max.z) / 2; c.box.expandByScalar(4); }
  },

  buildRamps() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xa8a39a, roughness: 0.8, map: makeNoiseTexture(128, [168, 163, 154], 26) });
    const stripe = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.6 });
    for (const r of this.ramps) {
      const mesh = new THREE.Mesh(makeWedge(r.width, r.height, r.len), mat);
      mesh.position.set(r.x, r.base, r.z); mesh.rotation.y = r.yaw; mesh.castShadow = true; mesh.receiveShadow = true;
      const lip = new THREE.Mesh(new THREE.BoxGeometry(r.width, 0.05, 0.6), stripe);
      lip.position.set(0, r.height - 0.02, -r.len / 2 + 0.3); lip.rotation.x = Math.atan(r.slope);
      mesh.add(lip); this.group.add(mesh);
    }
  },

  // ---------------------------------------------------------------- Laufzeit
  update(dt, camera, focus) {
    this.time += dt;
    const T = this.updateTimers;
    // Wasser bewegt sich
    this.waterNormal.offset.x += dt * 0.006; this.waterNormal.offset.y += dt * 0.004;
    if (this.waterU) this.waterU.uTime.value += dt;
    if ((T.lod -= dt) <= 0) { T.lod = 0.25; this.updateTerrainLod(camera); }
    if ((T.sig -= dt) <= 0) { T.sig = 0.3; this.updateSignals(); }
    this.updateFallers(dt);
    if (this.windT) this.windT.value += dt;
    if (this.treesDirty) { this.treesDirty = false; T.trees = 0; }
    const moved = camera.position.distanceToSquared(this.lastTreePos) > 100;
    if ((T.trees -= dt) <= 0 || moved) { T.trees = 0.25; this.updateTrees(camera); this.lastTreePos.copy(camera.position); }
    if ((T.lights -= dt) <= 0) { T.lights = 0.3; this.updateLampLights(focus); }
  },

  updateTerrainLod(camera) {
    const cx = camera.position.x, cz = camera.position.z;
    let built = false;
    for (const ch of this.chunks) {
      const dx = Math.max(ch.x0 - cx, 0, cx - ch.x1), dz = Math.max(ch.z0 - cz, 0, cz - ch.z1);
      const d = Math.hypot(dx, dz);
      let lvl = d < this.q.terrainNear ? 0 : d < 1000 ? 1 : 2;
      if (lvl === 0 && !ch.lod[0]) {
        if (built) lvl = 1;                    // höchstens eine neue Kachel pro Durchlauf bauen
        else { ch.lod[0] = this.makeChunkMesh(ch.ci, ch.cj, 1); this.group.add(ch.lod[0]); built = true; }
      }
      if (lvl !== ch.level) {
        for (let k = 0; k < 3; k++) if (ch.lod[k]) ch.lod[k].visible = k === lvl;
        ch.level = lvl;
      }
      // weit entfernte Detail-Kacheln wieder freigeben (Speicher)
      if (ch.lod[0] && d > this.q.terrainNear + 500) { this.group.remove(ch.lod[0]); ch.lod[0].geometry.dispose(); ch.lod[0] = null; }
    }
  },

  updateTrees(camera) {
    camera.updateMatrixWorld();
    this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._pm);
    const cx = camera.position.x, cz = camera.position.z;
    const far = this.q.treeFar, near = this.q.treeNear;
    const cnt = [[0, 0], [0, 0]];   // [near, far][type]
    const M = this.treeM, Cc = this.treeC;
    for (const ch of this.treeChunks) {
      const dx = Math.max(ch.box.min.x - cx, 0, cx - ch.box.max.x), dz = Math.max(ch.box.min.z - cz, 0, cz - ch.box.max.z);
      const d = Math.hypot(dx, dz);
      if (d > far || !this.frustum.intersectsBox(ch.box)) continue;
      const lvl = d < near ? 0 : 1;
      for (let t = 0; t < 2; t++) {
        const list = ch.lists[t], im = lvl === 0 ? this.treeNear[t] : this.treeFar[t];
        const ma = im.instanceMatrix.array, ca = im.instanceColor.array;
        let c = cnt[lvl][t];
        const st = this.treeState;
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (st[i] === 1) continue;                       // umgefallen
          ma.set(M.subarray(i * 16, i * 16 + 16), c * 16);
          if (st[i] === 2) { const g = this.treeGrow[i], o = c * 16; for (const q of [0, 1, 2, 4, 5, 6, 8, 9, 10]) ma[o + q] *= g; }   // wächst nach
          ca[c * 3] = Cc[i * 3]; ca[c * 3 + 1] = Cc[i * 3 + 1]; ca[c * 3 + 2] = Cc[i * 3 + 2];
          c++;
        }
        cnt[lvl][t] = c;
      }
    }
    for (let t = 0; t < 2; t++) {
      for (const [im, c] of [[this.treeNear[t], cnt[0][t]], [this.treeFar[t], cnt[1][t]]]) {
        im.count = c; im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true;
      }
    }
  },

  /** Nachts: die nächsten Laternen bekommen echte Punktlichter. */
  updateLampLights(focus) {
    if (!this.night || !this.lampLights.length) return;
    const cand = [];
    this.lampHash.near(focus.x, focus.z, 90, (b) => { if (!b._seen) { b._seen = true; cand.push(b); } });
    for (const b of cand) b._seen = false;
    cand.sort((a, b) => ((a[0] - focus.x) ** 2 + (a[2] - focus.z) ** 2) - ((b[0] - focus.x) ** 2 + (b[2] - focus.z) ** 2));
    this.lampLights.forEach((l, i) => {
      const b = cand[i];
      if (b) { l.position.set(b[0], b[1] - 0.4, b[2]); l.intensity = 55; } else l.intensity = 0;
    });
  },

  /** Nasse Fahrbahn: dunkler und glatter → spiegelt Himmel und Lichter. */
  /**
   * Pfützen bei Nässe: in Weltkoordinaten verteilte Flecken (v. a. in Spurrinnen und am Rand),
   * dort spiegelglatt und dunkel – zeigen Himmel, Lichter und Häuser. Füllen sich mit der Nässe.
   */
  addPuddles(m) {
    this.puddleU = this.puddleU || { value: 0 };
    const U = this.puddleU, prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev?.call(m, sh, r);
      sh.uniforms.uPuddle = U;
      sh.vertexShader = 'varying vec3 vPW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vPW = (modelMatrix * vec4(position, 1.0)).xyz;');
      sh.fragmentShader = 'uniform float uPuddle; varying vec3 vPW;\n'
        + 'float pn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5); float b = fract(sin(dot(i + vec2(1, 0), vec2(127.1, 311.7))) * 43758.5); float c = fract(sin(dot(i + vec2(0, 1), vec2(127.1, 311.7))) * 43758.5); float d = fract(sin(dot(i + vec2(1, 1), vec2(127.1, 311.7))) * 43758.5); return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }\n'
        + sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>
          float pdl = 0.0;
          if (uPuddle > 0.01) { float nz = pn(vPW.xz * 0.23) * 0.65 + pn(vPW.xz * 0.9) * 0.35;
            pdl = smoothstep(0.78 - uPuddle * 0.22, 0.83 - uPuddle * 0.2, nz) * uPuddle; }
          diffuseColor.rgb *= 1.0 - pdl * 0.55;`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.02, pdl);')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = normalize(mix(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), pdl));');
    };
  },

  setWet(w) {
    this.wet = w;
    if (this.puddleU) this.puddleU.value = w;
    for (const m of this.wetMats || []) { m.roughness = lerp(0.82, 0.3, w); m.color.setScalar(lerp(1, 0.55, w)); m.envMapIntensity = 1 + w * 0.9; }
    if (this.terrainMat) this.terrainMat.color.setScalar(lerp(1, 0.82, w));
  },

  setNight(on) {
    this.night = on;
    this.windowGlow.value = on ? 1.1 : 0;
    if (this.signMat) this.signMat.emissiveIntensity = on ? 2.4 : 0.25;
    this.halos.visible = on;
    this.bulbMat.color.set(on ? 0xffd9a6 : 0x6a655c);
    if (on) this.bulbMat.color.multiplyScalar(4);
    this.poolMat.color.setRGB(0.95, 0.66, 0.36);   // kräftiger, warmer Lichtkegel auf dem Asphalt
    this.pools.visible = on;
    for (const l of this.lampLights) l.intensity = 0;
    this.waterMat.color.set(on ? 0x0a1a22 : 0x1b4250);
    if (on) this.updateLampLights(this.camera.position);
  },
});

// ============================== Welt: umfallende Bäume ==============================
Object.assign(World.prototype, {
  /**
   * Bäume gegen Auto. Langsam: Stamm ist fest (wie eine Wand).
   * Schnell: Baum knickt am Stamm um und fällt in Stoßrichtung; das Auto
   * verliert je nach Wucht und Baumgröße Tempo, prallt aber nicht ab.
   */
  collideTrees(v, px, pz, fx, fz, rx, rz, HX, HZ, stamp) {
    const T = this.trees;
    if (!T || !this.treeHash) return;
    this.treeHash.near(px, pz, 3.6, (i) => {
      if (this.treeState[i] !== 0 || this.treeStamp[i] === stamp) return;
      this.treeStamp[i] = stamp;
      const s = T.s[i], tx = T.x[i], tz = T.z[i], ty = T.y[i];
      if (v.pos.y - 0.45 > ty + 4.5 * s) return;               // drüber gesprungen/geflogen
      const lx = (tx - px) * rx + (tz - pz) * rz, lz = -((tx - px) * fx + (tz - pz) * fz);
      const cx = clamp(lx, -HX, HX), cz = clamp(lz, -HZ, HZ);
      const dx = lx - cx, dz = lz - cz, d = Math.hypot(dx, dz);
      const tr = (T.t[i] ? 0.36 : 0.3) * s;
      if (d >= tr) return;
      let nx, nz;
      if (d > 1e-4) { const nlx = -dx / d, nlz = -dz / d; nx = rx * nlx - fx * nlz; nz = rz * nlx - fz * nlz; }
      else { const sp = Math.hypot(v.vel.x, v.vel.z) || 1; nx = -v.vel.x / sp; nz = -v.vel.z / sp; }
      const impact = -(v.vel.x * nx + v.vel.z * nz);
      const breakAt = 3.5 + s * 2.5;
      if (impact > breakAt) {
        const sp = Math.hypot(v.vel.x, v.vel.z) || 1;
        let ddx = -nx * 0.4 + (v.vel.x / sp) * 0.6, ddz = -nz * 0.4 + (v.vel.z / sp) * 0.6;
        const dl = Math.hypot(ddx, ddz) || 1; ddx /= dl; ddz /= dl;
        this.fellTree(i, ddx, ddz, impact);
        const loss = clamp(0.16 + s * 0.1 + (T.t[i] ? 0.05 : 0), 0.14, 0.42);
        v.vel.x += nx * impact * loss; v.vel.z += nz * impact * loss;
        v.angVel.y += (Math.random() - 0.5) * 0.5;
        v.lastImpact = Math.max(v.lastImpact, impact * 0.4);
        this.fx.push({ type: 'tree', x: tx, y: ty + 1.2, z: tz, s: impact, vx: v.vel.x, vz: v.vel.z, scale: s });
      } else {
        const wx = px + rx * cx - fx * cz, wz = pz + rz * cx - fz * cz;
        this.resolveContact(v, wx, wz, nx, nz, tr - d);
      }
    });
  },

  setupFallers() {
    this.treeState = new Uint8Array(this.trees.count);
    this.treeGrow = new Float32Array(this.trees.count);
    this.treeStamp = new Uint32Array(this.trees.count);
    this.regrow = [];
    this.fallers = [];
    for (let k = 0; k < 10; k++) {
      const mat = this.treeMat.clone(); mat.transparent = true;
      const mesh = new THREE.Mesh(this.treeNear[0].geometry, mat);
      mesh.visible = false; mesh.castShadow = this.q.shadows; mesh.frustumCulled = false;
      this.group.add(mesh);
      this.fallers.push({ mesh, active: false, t: 0 });
    }
    this._fq = new THREE.Quaternion(); this._fy = new THREE.Quaternion(); this._fa = new THREE.Vector3();
  },

  fellTree(i, dx, dz, speed) {
    const T = this.trees;
    this.treeState[i] = 1; this.treesDirty = true;
    let f = this.fallers.find((o) => !o.active);
    if (!f) { f = this.fallers.reduce((a, b) => (a.t > b.t ? a : b)); }
    f.active = true; f.i = i; f.t = 0; f.theta = 0; f.landed = false;
    f.omega = 0.35 + speed * 0.035;
    f.h = (T.t[i] ? 8.5 : 11) * T.s[i];
    f.axis = new THREE.Vector3(dz, 0, -dx);
    f.mesh.geometry = this.treeNear[T.t[i]].geometry;
    f.mesh.material.opacity = 1; f.mesh.visible = true;
    f.mesh.position.set(T.x[i], T.y[i], T.z[i]);
    f.mesh.scale.setScalar(T.s[i]);
    f.yaw = T.r[i];
    this.regrow.push({ i, t: 45 + Math.random() * 30 });
  },

  updateFallers(dt) {
    if (!this.fallers) return;
    const maxT = Math.PI / 2 - 0.1;
    for (const f of this.fallers) {
      if (!f.active) continue;
      f.t += dt;
      // Kippen um den Stammfuß: Schwerkraft-Moment wächst mit dem Winkel
      const alpha = (1.5 * 9.81 / f.h) * Math.sin(f.theta + 0.06);
      f.omega += alpha * dt;
      f.theta += f.omega * dt;
      if (f.theta >= maxT) {
        f.theta = maxT; f.omega = -Math.abs(f.omega) * 0.16;
        if (!f.landed) { f.landed = true; const T = this.trees; this.fx.push({ type: 'treeLand', x: T.x[f.i] + f.axis.z * f.h * 0.6, y: T.y[f.i] + 0.5, z: T.z[f.i] - f.axis.x * f.h * 0.6 }); }
      }
      this._fy.setFromAxisAngle(this._fa.set(0, 1, 0), f.yaw);
      this._fq.setFromAxisAngle(f.axis, f.theta).multiply(this._fy);
      f.mesh.quaternion.copy(this._fq);
      if (f.t > 4.5) f.mesh.material.opacity = Math.max(0, 1 - (f.t - 4.5) / 1.6);
      if (f.t > 6.1) { f.active = false; f.mesh.visible = false; }
    }
    // Nachwachsen
    for (let k = this.regrow.length - 1; k >= 0; k--) {
      const r = this.regrow[k];
      r.t -= dt;
      if (r.t <= 0 && this.treeState[r.i] === 1) { this.treeState[r.i] = 2; this.treeGrow[r.i] = 0.05; this.treesDirty = true; }
      if (this.treeState[r.i] === 2) {
        this.treeGrow[r.i] = Math.min(1, this.treeGrow[r.i] + dt / 6);
        this.treesDirty = true;
        if (this.treeGrow[r.i] >= 1) { this.treeState[r.i] = 0; this.regrow.splice(k, 1); }
      }
    }
  },
});

export { WORLD, ROAD_CLASS, SURF_GRIP, SURF_ROLL, SpatialHash, EMPTY_ARR, rectMask, splinePoints, mergeParts, jitter, gradientColors, World, makeGroundTextures, makeBlobTexture, mergeUV, makeFoliageAtlas, makeRoadTexture, makeFacadeTextures, makeDetailTexture, makeWaterNormal, radialTexture };
