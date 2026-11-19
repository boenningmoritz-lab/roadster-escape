import * as THREE from 'three';
import { radialTexture } from '../world/world.js';
import { clamp, lerp, smoothstep, damp, approach, Settings } from '../config.js';
import { smoothNormals } from '../environment.js';

// ============================== CarModel ==============================
/**
 * Roadster „Voltara Aero R“ aus Three.js-Geometrien.
 * Karosserie = extrudierte Seitenprofile (Seitenteile + Mitte mit Cockpit-Ausschnitt),
 * Glaskuppel, Innenraum, Räder mit Felgen/Bremsen, Licht vorne/hinten.
 */
/** Weiche Flammen-Textur (radial, mit ausgefranstem Rand); einmal erzeugt, von allen Sprites geteilt. */
let _flameTex = null;
function flameTex() {
  if (_flameTex) return _flameTex;
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d'), img = c.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2), r = Math.hypot(dx, dy);
    const a = Math.atan2(dy, dx), edge = 0.75 + 0.18 * Math.sin(a * 5) + 0.08 * Math.sin(a * 11 + 1);
    const v = Math.max(0, 1 - r / edge) ** 1.6;
    const k = (y * S + x) * 4; d[k] = d[k + 1] = d[k + 2] = 255; d[k + 3] = Math.round(v * 255);
  }
  c.putImageData(img, 0, 0);
  _flameTex = new THREE.CanvasTexture(cv);
  return _flameTex;
}

/** Reifenprofil: vier Längsrillen und schräge Lamellen (u = Umfang, v = Breite). */
function makeTreadTexture() {
  const W = 512, H = 128, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#1b1b1c'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#080808';
  for (const v of [0.2, 0.4, 0.6, 0.8]) c.fillRect(0, v * H - 3, W, 6);                     // Längsrillen
  c.strokeStyle = '#0b0b0b'; c.lineWidth = 2.5;
  for (let u = 0; u < W; u += 12) for (const [a, b] of [[0, 0.2], [0.4, 0.6], [0.8, 1]]) { c.beginPath(); c.moveTo(u, a * H + 4); c.lineTo(u + 9, b * H - 4); c.stroke(); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.repeat.set(6, 1); t.anisotropy = 4;
  return t;
}

/** Reifenflanke: Gummi mit erhabenem Schriftzug im Kreis (Fantasiemarke, keine echte Marke). */
function makeSidewallTexture(R) {
  const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const c = cv.getContext('2d');
  c.fillStyle = '#151516'; c.fillRect(0, 0, S, S);
  const rText = (0.268 / R) * S * 0.5;               // Textring knapp außerhalb der Felge
  c.font = `bold ${Math.round(S * 0.032)}px sans-serif`; c.fillStyle = '#4a4a4c'; c.textAlign = 'center'; c.textBaseline = 'middle';
  const write = (txt, a0) => {
    const step = 0.052;
    for (let i = 0; i < txt.length; i++) {
      const a = a0 + (i - txt.length / 2) * step;
      c.save(); c.translate(S / 2 + Math.cos(a) * rText, S / 2 + Math.sin(a) * rText); c.rotate(a + Math.PI / 2); c.fillText(txt[i], 0, 0); c.restore();
    }
  };
  write('VOLTARA AERO-GRIP', -Math.PI / 2); write('275/30 ZR21  101Y', Math.PI / 2);
  c.strokeStyle = '#2a2a2c'; c.lineWidth = 2; c.beginPath(); c.arc(S / 2, S / 2, rText + S * 0.03, 0, 6.3); c.stroke();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** „Orangenhaut“ des Klarlacks: feine, weiche Welligkeit als Normal-Map (nur Grafik Hoch). */
function makeOrangePeel() {
  const N = 128, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
  const h = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) h[i] = Math.random();
  for (let pass = 0; pass < 3; pass++) {            // weichzeichnen → sanfte Hügel
    const t = h.slice();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let a = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) a += t[((y + dy + N) % N) * N + ((x + dx + N) % N)];
      h[y * N + x] = a / 9;
    }
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const nx = (h[y * N + (x + 1) % N] - h[y * N + (x + N - 1) % N]) * 8, ny = (h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x]) * 8;
    const k = (y * N + x) * 4; d[k] = 128 + nx * 127; d[k + 1] = 128 + ny * 127; d[k + 2] = 255; d[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(6, 6);
  return t;
}

class CarModel {
  constructor(cfg, q) {
    this.cfg = cfg; this.q = q;
    this.root = new THREE.Group();      // im Schwerpunkt-System des Fahrzeugs
    const body = new THREE.Group();     // Modell ist mit y = 0 auf Bodenhöhe gebaut,
    this.root.add(body);                // Versatz zum Schwerpunkt folgt am Ende
    this.body = body;

    // ---------- Materialien ----------
    // Perlweiß mit Klarlack (Phase 9: Farbe in der Garage wählbar)
    const paintCol = new THREE.Color(Settings.data.paint || '#f2f2ee');
    this.paint = q.physicalPaint
      ? new THREE.MeshPhysicalMaterial({ color: paintCol, metalness: 0.12, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03,
        clearcoatNormalMap: makeOrangePeel(), clearcoatNormalScale: new THREE.Vector2(0.12, 0.12) })
      : new THREE.MeshStandardMaterial({ color: paintCol, metalness: 0.12, roughness: 0.28 });
    this.paint.envMapIntensity = 0.75;
    // Schmutz nach Offroad-Fahrten: unten und an den Flanken fleckig braun, Regen wäscht ihn langsam ab
    this.dirtU = { value: 0 };
    { const dirtU = this.dirtU, prev = this.paint.onBeforeCompile;
      this.paint.onBeforeCompile = (sh, r) => {
        prev?.(sh, r);
        sh.uniforms.uDirt = dirtU;
        sh.vertexShader = 'varying vec3 vDirtP;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vDirtP = position;');
        sh.fragmentShader = 'uniform float uDirt; varying vec3 vDirtP;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
          { float n = fract(sin(dot(floor(vDirtP.xz * 9.0), vec2(12.9898, 78.233))) * 43758.5453) * 0.5 + 0.5 * sin(vDirtP.x * 23.0 + vDirtP.z * 17.0);
            float low = 1.0 - smoothstep(0.25, 0.75, vDirtP.y);
            float k = clamp(uDirt * (low * 1.3 + 0.15) * (0.55 + 0.45 * n), 0.0, 0.85);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.21, 0.11), k); }`)
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.85, clamp(uDirt * 0.8, 0.0, 0.8));');
      };
    }
    const black = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.55, metalness: 0.3 });
    const carbon = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.35, metalness: 0.4 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0a1018, roughness: 0.05, metalness: 0.9, transparent: true, opacity: 0.42, depthWrite: false });
    const interior = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.8 });
    const seatMat = this.seatMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.75 });
    const seatAccent = new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 0.7 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdfeeff, emissiveIntensity: 2.2 });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x400008, emissive: 0xff1030, emissiveIntensity: 0.9 });
    this.revMat = new THREE.MeshStandardMaterial({ color: 0x555555, emissive: 0xffffff, emissiveIntensity: 0 });

    const bevelSegs = q.bevelSegs;

    // ---------- Seitenprofil (z = Länge, y = Höhe), mit Radausschnitten ----------
    const R = cfg.wheelRadius;
    const archs = [{ cx: cfg.wheels[0].z, r: R + 0.07 }, { cx: cfg.wheels[2].z, r: R + 0.07 }];
    const bottomY = 0.2;
    const makeProfile = (cockpit) => {
      const s = new THREE.Shape();
      s.moveTo(-2.08, bottomY);
      for (const a of archs) {
        const dy = bottomY - R;                                // Bogenmittelpunkt auf Radmitte
        const d = Math.asin(clamp(dy / a.r, -1, 1));
        const a0 = Math.PI - d, a1 = d;
        s.lineTo(a.cx + Math.cos(a0) * a.r, bottomY);
        for (let i = 0; i <= 16; i++) {
          const th = lerp(a0, a1, i / 16);
          s.lineTo(a.cx + Math.cos(th) * a.r, R + Math.sin(th) * a.r);
        }
      }
      s.lineTo(2.02, 0.22);
      s.quadraticCurveTo(2.22, 0.26, 2.24, 0.5);       // Heckschürze
      s.quadraticCurveTo(2.25, 0.76, 2.17, 0.84);      // Abrisskante (Ducktail)
      s.quadraticCurveTo(1.7, 0.86, 1.15, 0.92);       // Heckdeck → Kotflügel
      if (cockpit) {
        s.quadraticCurveTo(0.95, 0.94, 0.84, 0.88);
        s.lineTo(0.72, 0.5); s.lineTo(-0.6, 0.5); s.lineTo(-0.74, 0.79);
      } else {
        s.quadraticCurveTo(0.3, 0.95, -0.74, 0.79);    // Schulterlinie
      }
      s.bezierCurveTo(-1.3, 0.75, -1.75, 0.66, -2.04, 0.55);   // Motorhaube
      s.quadraticCurveTo(-2.27, 0.48, -2.25, 0.36);            // Nase
      s.quadraticCurveTo(-2.22, 0.22, -2.08, bottomY);
      return s;
    };
    /**
     * Verformt die extrudierte Platte zu einer organischen Karosserie:
     * runde Ecken in der Draufsicht, gewölbte Oberseite, schmalere Nase,
     * ausgestellte hintere Kotflügel.
     */
    const halfW = 0.98;
    const sculpt = (g, xOff) => {
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        let x = p.getX(i) + xOff, y = p.getY(i), z = p.getZ(i);
        const ax = clamp(Math.abs(x) / halfW, 0, 1);
        const tEnd = smoothstep(1.35, 2.35, Math.abs(z));
        z -= Math.sign(z) * tEnd * 0.26 * ax * ax;                       // runde Ecken
        x *= 1 - 0.09 * smoothstep(1.4, 2.3, -z);                        // schmalere Nase
        x *= 1 + 0.035 * Math.exp(-((z - cfg.wheels[2].z) ** 2) / 0.35) * smoothstep(0.55, 0.9, ax); // Hüfte hinten
        y -= 0.085 * ax ** 4 * smoothstep(0.42, 0.85, y);                // Wölbung oben
        p.setXYZ(i, x, y, z);
      }
      p.needsUpdate = true;
      smoothNormals(g, 38);
    };
    const extrudeX = (shape, width, bevel, mat, xOff) => {
      const depth = Math.max(width - bevel * 2, 0.01);
      const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: bevelSegs, curveSegments: q.bevelSegs > 1 ? 10 : 5 });
      g.translate(0, 0, -depth / 2);
      g.rotateY(-Math.PI / 2);
      sculpt(g, xOff);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true; m.receiveShadow = true;
      body.add(m);
      return m;
    };
    const sideW = 0.48;                 // überlappt die Mitte → keine sichtbaren Fugen
    const shells = [
      extrudeX(makeProfile(false), sideW, 0.09, this.paint, -halfW + sideW / 2),   // linke Seite
      extrudeX(makeProfile(false), sideW, 0.09, this.paint, halfW - sideW / 2),    // rechte Seite
      extrudeX(makeProfile(true), 1.2, 0.09, this.paint, 0),                       // Mitte mit Cockpit
    ];
    // Hilfsfunktion: Punkt auf der echten Karosserie-Oberfläche finden (für Lichter usw.)
    const ray = new THREE.Raycaster();
    const surf = (x, y, z, dx, dy, dz, push = 0.012) => {
      ray.set(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz));
      const hit = ray.intersectObjects(shells, false)[0];
      if (!hit) return new THREE.Vector3(x, y, z);
      return hit.point.addScaledVector(ray.ray.direction, -push);
    };

    // Radhäuser (dunkel) – verhindern Durchblick
    for (const a of archs) {
      const well = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, a.r * 2), black);
      well.position.set(0, R + 0.08, a.cx); body.add(well);
    }

    // Glaskuppel (Targa-Dach) über dem Cockpit
    const canopy = new THREE.Shape();
    canopy.moveTo(-0.78, 0.78);
    canopy.quadraticCurveTo(-0.25, 1.1, 0.25, 1.13);
    canopy.quadraticCurveTo(0.68, 1.12, 0.86, 0.88);
    canopy.lineTo(-0.78, 0.78);
    const cg = new THREE.ExtrudeGeometry(canopy, { depth: 1.18, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.06, bevelSegments: bevelSegs + 1, curveSegments: 10 });
    cg.translate(0, 0, -0.59); cg.rotateY(-Math.PI / 2);
    const canopyMesh = new THREE.Mesh(cg, glass); canopyMesh.renderOrder = 2; body.add(canopyMesh);
    // Dachrahmen (A-Säulen-Optik)
    // schlanke A-Säulen + Scheibenrahmen oben (Roadster), dazu Innenspiegel
    {
      // Nur in der Ego-Sicht: Frontscheibenrahmen hoch über der Augenlinie (Fahrer sitzt höher, Sicht frei);
      // von außen sieht man stattdessen die flache Glaskuppel.
      this.cockpitOnly = new THREE.Group(); this.cockpitOnly.visible = false; body.add(this.cockpitOnly);
      const tubeM = (pts, r) => { const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, r, 8, false), black); this.cockpitOnly.add(m); return m; };
      for (const sx of [-1, 1]) tubeM([new THREE.Vector3(sx * 0.66, 0.84, -0.78), new THREE.Vector3(sx * 0.63, 1.08, -0.5), new THREE.Vector3(sx * 0.58, 1.33, -0.2)], 0.012);
      tubeM([new THREE.Vector3(-0.58, 1.33, -0.2), new THREE.Vector3(0, 1.36, -0.2), new THREE.Vector3(0.58, 1.33, -0.2)], 0.014);
      const rv = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.055, 0.025), black); rv.position.set(0.05, 1.3, -0.19); rv.rotation.x = -0.12; this.cockpitOnly.add(rv);
      // Spiegelglas: zeigt (in der Ego-Sicht) ein echtes Bild nach hinten – Render-Target, siehe Game.updateMirrors
      this.mirrorMat = new THREE.MeshBasicMaterial({ color: 0x9aa4ae });
      const rvgGeo = new THREE.PlaneGeometry(0.185, 0.045); { const uv = rvgGeo.attributes.uv; for (let i = 0; i < uv.count; i++) { uv.setX(i, 0.2 + (1 - uv.getX(i)) * 0.6); uv.setY(i, 0.25 + uv.getY(i) * 0.5); } }
      const rvg = new THREE.Mesh(rvgGeo, this.mirrorMat);
      rvg.position.set(0.05, 1.3, -0.176); rvg.rotation.x = -0.12; this.cockpitOnly.add(rvg);
      this.canopyMesh = canopyMesh;
    }

    // Unterboden, Splitter, Diffusor, Seitenschweller
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; body.add(m); return m; };
    add(new THREE.BoxGeometry(1.7, 0.06, 3.9), black, 0, 0.2, 0);
    add(new THREE.BoxGeometry(1.5, 0.025, 0.3), carbon, 0, 0.19, -2.0);              // Frontsplitter
    add(new THREE.BoxGeometry(1.3, 0.04, 0.32), carbon, 0, 0.23, 1.9, 0.22);          // Diffusor
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.06, 0.08, 1.6), carbon, s * 0.97, 0.26, 0);
    // Außenspiegel
    // Außenspiegel: Fuß auf der Tür, Arm, Gehäuse in Wagenfarbe, echtes Spiegelglas nach hinten
    const mirrorGeo = new THREE.SphereGeometry(1, 16, 12);
    this.sideMirrorMat = new THREE.MeshBasicMaterial({ color: 0x9aa4ae });
    const mirrorGlass = this.sideMirrorMat;
    for (const s of [-1, 1]) {
      // Fuß sitzt exakt auf der Türoberkante (per Strahl auf die Karosserie ermittelt)
      const top = surf(s * 0.86, 2, -0.64, 0, -1, 0, 0).y;
      const hx = s * 1.03, hy = top + 0.085;
      add(new THREE.BoxGeometry(0.08, 0.04, 0.13), black, s * 0.86, top + 0.012, -0.64);                // Fuß
      const ax = (s * 0.88 + hx) / 2, ay = (top + 0.02 + hy) / 2, len = Math.hypot(hx - s * 0.88, hy - top - 0.02);
      add(new THREE.BoxGeometry(len + 0.02, 0.024, 0.045), carbon, ax, ay, -0.64, 0, 0, Math.atan2(hy - top - 0.02, hx - s * 0.88));   // Arm
      const m = add(mirrorGeo, this.paint, hx, hy, -0.64); m.scale.set(0.085, 0.052, 0.06);
      const cgeo = new THREE.CircleGeometry(1, 20); { const uv = cgeo.attributes.uv; for (let i = 0; i < uv.count; i++) { const u = uv.getX(i); uv.setX(i, s < 0 ? 0.62 + (1 - u) * 0.38 : (1 - u) * 0.38); uv.setY(i, 0.2 + uv.getY(i) * 0.6); } }
      const g = add(cgeo, mirrorGlass, hx, hy, -0.584); g.scale.set(0.072, 0.042, 1); g.castShadow = false;
    }

    // ---------- Lichter (auf der Karosserie-Oberfläche platziert) ----------
    const tube = (pts, r, mat) => {
      const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 3, r, 6, false), mat);
      body.add(m); return m;
    };
    const tailPts = [];
    for (let x = -0.86; x <= 0.861; x += 0.086) tailPts.push(surf(x, 0.77, 5, 0, 0, -1));
    tube(tailPts, 0.022, this.tailMat);                                      // durchgehendes Rücklichtband
    for (const sx of [-1, 1]) {
      const lo = []; for (let x = 0.62; x <= 0.9; x += 0.07) lo.push(surf(sx * x, 0.69, 5, 0, 0, -1));
      tube(lo, 0.03, this.tailMat);                                          // Bremsleuchten-Ecken
      const rv = surf(sx * 0.42, 0.42, 5, 0, 0, -1);
      add(new THREE.BoxGeometry(0.14, 0.04, 0.02), this.revMat, rv.x, rv.y, rv.z).castShadow = false;
      // Scheinwerfer: schlanke, nach außen ansteigende Lichtleiste
      const hp = []; for (let x = 0.36; x <= 0.84; x += 0.06) hp.push(surf(sx * x, 0.455 + (x - 0.36) * 0.12, -5, 0, 0, 1, 0.008));
      tube(hp, 0.026, this.headMat);
      const hp2 = []; for (let x = 0.48; x <= 0.8; x += 0.08) hp2.push(surf(sx * x, 0.41 + (x - 0.48) * 0.08, -5, 0, 0, 1, 0.006));
      tube(hp2, 0.012, this.headMat);
      // Front-Lufteinlass
      const fi = surf(sx * 0.52, 0.31, -5, 0, 0, 1, -0.005);
      add(new THREE.BoxGeometry(0.4, 0.08, 0.06), black, fi.x, fi.y, fi.z);
      // Seitlicher Lufteinlass hinter der Tür
      const si = surf(sx * 3, 0.55, 0.85, -sx, 0, 0, -0.01);
      add(new THREE.BoxGeometry(0.04, 0.11, 0.4), black, si.x, si.y, si.z, 0, 0, 0);
    }

    // Kennzeichen vorn/hinten (Fantasie-Kennzeichen), Türfugen, versenkte Türgriffe
    {
      const plateTex = (() => {
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 56; const c = cv.getContext('2d');
        c.fillStyle = '#f4f4f0'; c.fillRect(0, 0, 256, 56); c.strokeStyle = '#222'; c.lineWidth = 3; c.strokeRect(2, 2, 252, 52);
        c.fillStyle = '#1d3f9a'; c.fillRect(4, 4, 22, 48); c.fillStyle = '#ffd400'; c.font = 'bold 10px sans-serif'; c.fillText('VE', 8, 46);
        c.fillStyle = '#111'; c.font = 'bold 34px sans-serif'; c.textBaseline = 'middle'; c.fillText('VA·AR 2026', 34, 30);
        const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
      })();
      const plateMat = new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.4, metalness: 0.1 });
      const pf = surf(0, 0.36, -5, 0, 0, 1, 0.004), pr = surf(0, 0.5, 5, 0, 0, -1, 0.004);
      add(new THREE.PlaneGeometry(0.52, 0.114), plateMat, pf.x, pf.y, pf.z, 0, Math.PI, 0).castShadow = false;
      add(new THREE.PlaneGeometry(0.52, 0.114), plateMat, pr.x, pr.y, pr.z).castShadow = false;
      const gap = new THREE.MeshBasicMaterial({ color: 0x0a0a0c });
      for (const sx of [-1, 1]) {
        // Türfuge vorn und hinten (dünne dunkle Linie auf der Flanke)
        for (const z of [-0.62, 0.62]) {
          const pts = []; for (let y = 0.32; y <= 0.78; y += 0.04) pts.push(surf(sx * 3, y, z, -sx, 0, 0, -0.001));
          const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.0035, 4, false), gap); body.add(m);
        }
        const gp = surf(sx * 3, 0.7, 0.3, -sx, 0, 0, -0.002);
        add(new THREE.BoxGeometry(0.012, 0.025, 0.16), black, gp.x, gp.y, gp.z).castShadow = false;     // Türgriff
      }
    }

    // Scheinwerfer-Lichtkegel (Phase 4 nutzt sie für die Nacht)
    this.headLights = [];
    {
      for (const s of (q.headlights ? [-1, 1] : [0])) {
        const sl = new THREE.SpotLight(0xf2f6ff, 0, 160, 0.5, 0.55, 1.25);
        sl.position.set(s * 0.62, 0.56, -2.1);
        sl.target.position.set(s * 0.9, 0, -16);
        body.add(sl); body.add(sl.target);
        this.headLights.push(sl);
      }
    }

    // ---------- Innenraum (im Cockpit-Modus sichtbar) ----------
    const leather = new THREE.MeshStandardMaterial({ color: 0x232327, roughness: 0.85 });
    const alu = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.9, roughness: 0.3 });
    this.ambientMat = new THREE.MeshBasicMaterial({ color: 0x36e0ff });          // Ambientelicht (Phase 9: Farbe wählbar)
    add(new THREE.BoxGeometry(1.15, 0.03, 1.35), interior, 0, 0.5, 0.05);           // Boden
    // Armaturenbrett: Unterteil, gepolsterte Oberseite, Hutze über dem Fahrer-Display
    const alcantara = new THREE.MeshStandardMaterial({ color: 0x2b2b2f, roughness: 1 });
    const stitch = new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.7 });
    {
      // Profil (z, y): Stirnwand → gepolsterte, nach hinten abfallende Oberseite → Lippe → Kniebereich
      const sh = new THREE.Shape();
      sh.moveTo(-0.8, 0.64); sh.lineTo(-0.8, 0.82);
      sh.quadraticCurveTo(-0.66, 0.875, -0.5, 0.872);
      sh.quadraticCurveTo(-0.42, 0.868, -0.41, 0.83);
      sh.quadraticCurveTo(-0.4, 0.74, -0.47, 0.64); sh.lineTo(-0.8, 0.64);
      const g = new THREE.ExtrudeGeometry(sh, { depth: 1.18, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 3, curveSegments: 12 });
      g.translate(0, 0, -0.59); g.rotateY(-Math.PI / 2);
      const dash = new THREE.Mesh(g, alcantara); body.add(dash);
      add(new THREE.BoxGeometry(1.16, 0.004, 0.004), stitch, 0, 0.862, -0.43).castShadow = false;   // Ziernaht an der Lippe
      // Hutze über dem Fahrer-Display (halbe Röhre)
      const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.16, 20, 1, true, -Math.PI / 2, Math.PI), alcantara);
      hood.material = alcantara; hood.rotation.set(Math.PI / 2, 0, 0); hood.scale.set(1, 1, 0.42); hood.position.set(-0.33, 0.9, -0.6);
      hood.material.side = THREE.DoubleSide; body.add(hood);
      // Lüftungsdüsen: Alu-Ring, dunkler Grund, Lamellen
      for (const vx of [-0.52, -0.1, 0.1, 0.52]) {
        const ring = add(new THREE.TorusGeometry(0.038, 0.006, 6, 18), alu, vx, 0.79, -0.43); ring.castShadow = false;
        add(new THREE.CircleGeometry(0.036, 18), black, vx, 0.79, -0.432).castShadow = false;
        for (let k = -2; k <= 2; k++) add(new THREE.BoxGeometry(0.066, 0.004, 0.012), alu, vx, 0.79 + k * 0.012, -0.428).castShadow = false;
      }
    }
    add(new THREE.BoxGeometry(1.1, 0.012, 0.012), this.ambientMat, 0, 0.8, -0.425).castShadow = false;
    // Mittelkonsole mit Wählhebel
    add(new THREE.BoxGeometry(0.2, 0.19, 0.95), carbon, 0, 0.6, -0.02);                         // Tunnel (Carbon)
    add(new THREE.BoxGeometry(0.19, 0.035, 0.32), leather, 0, 0.71, 0.26);                       // Armlehne
    add(new THREE.BoxGeometry(0.19, 0.003, 0.003), stitch, 0, 0.729, 0.26).castShadow = false;
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.004, 0.004, 0.62), alu, sx * 0.1, 0.697, -0.15).castShadow = false;  // Alu-Zierleisten
    // Wählhebel (Alu-Kugel auf Ledermanschette) und Tastenreihe
    add(new THREE.CylinderGeometry(0.03, 0.04, 0.03, 14), leather, 0, 0.71, -0.1);
    add(new THREE.CylinderGeometry(0.011, 0.013, 0.07, 10), alu, 0, 0.74, -0.1);
    add(new THREE.SphereGeometry(0.024, 14, 10), alu, 0, 0.78, -0.1);
    for (let k = 0; k < 4; k++) {
      add(new THREE.BoxGeometry(0.032, 0.012, 0.03), black, -0.054 + k * 0.036, 0.702, -0.3).castShadow = false;
      add(new THREE.BoxGeometry(0.012, 0.002, 0.004), this.ambientMat, -0.054 + k * 0.036, 0.709, -0.29).castShadow = false;
    }
    // Türverkleidungen mit Ambientelicht-Leiste
    for (const sx of [-1, 1]) {
      add(new THREE.BoxGeometry(0.05, 0.26, 1.25), leather, sx * 0.6, 0.66, 0.0);
      add(new THREE.BoxGeometry(0.012, 0.012, 1.1), this.ambientMat, sx * 0.574, 0.76, 0.0).castShadow = false;
      add(new THREE.BoxGeometry(0.05, 0.03, 0.3), alu, sx * 0.574, 0.7, -0.15);     // Türöffner
      add(new THREE.BoxGeometry(0.07, 0.04, 0.5), leather, sx * 0.56, 0.72, 0.12);  // Armauflage
      add(new THREE.BoxGeometry(0.004, 0.004, 0.5), stitch, sx * 0.524, 0.742, 0.12).castShadow = false;
      add(new THREE.TorusGeometry(0.06, 0.006, 6, 20), alu, sx * 0.578, 0.6, -0.42, 0, Math.PI / 2, 0).castShadow = false;   // Lautsprecher
      add(new THREE.CircleGeometry(0.058, 20), black, sx * 0.582, 0.6, -0.42, 0, -sx * Math.PI / 2, 0).castShadow = false;
    }
    // Sportsitze: Sitzfläche, Lehne, Seitenwangen, Kopfstütze
    for (const sx of [-0.33, 0.33]) {
      add(new THREE.BoxGeometry(0.4, 0.08, 0.46), seatMat, sx, 0.55, 0.2);
      add(new THREE.BoxGeometry(0.4, 0.44, 0.08), seatMat, sx, 0.78, 0.47, -0.25);
      for (const b of [-1, 1]) {
        add(new THREE.BoxGeometry(0.06, 0.1, 0.44), seatAccent, sx + b * 0.21, 0.6, 0.2);
        add(new THREE.BoxGeometry(0.06, 0.38, 0.1), seatAccent, sx + b * 0.21, 0.78, 0.44, -0.25);
      }
      add(new THREE.BoxGeometry(0.24, 0.12, 0.07), seatAccent, sx, 1.0, 0.53, -0.25);  // Kopfstütze
    }
    // Lenkrad (dreht sich mit) + Lenksäule
    add(new THREE.CylinderGeometry(0.025, 0.03, 0.32, 10), interior, -0.33, 0.8, -0.46, Math.PI / 2 - 0.35);
    this.steeringWheel = new THREE.Group();
    this.steeringWheel.position.set(-0.33, 0.8, -0.34); this.steeringWheel.scale.setScalar(0.92);
    this.steeringWheel.rotation.x = -0.35;
    const swRim = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.021, 10, 32), leather);
    const swHub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 16).rotateX(Math.PI / 2), carbon);
    const swSpoke = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.028, 0.02), carbon);
    const swSpokeB = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.15, 0.02), carbon); swSpokeB.position.y = -0.08;
    const swMark = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.034, 0.048), new THREE.MeshStandardMaterial({ color: 0xff8a1f, roughness: 0.6 }));   // 12-Uhr-Markierung
    swMark.position.y = 0.16;
    const swLogo = new THREE.Mesh(new THREE.CircleGeometry(0.025, 16), new THREE.MeshBasicMaterial({ color: 0x36e0ff }));
    swLogo.position.z = 0.021;
    // Lenkrad-Varianten: rund, Yoke, Sport (unten abgeflacht)
    const round = new THREE.Group(); round.add(swRim);
    const yoke = new THREE.Group();
    for (const sx of [-1, 1]) { const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.2, 10), leather); grip.position.set(sx * 0.16, -0.01, 0); yoke.add(grip); }
    const ybar = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.04), leather); ybar.position.y = -0.11; yoke.add(ybar);
    const sport = new THREE.Group();
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.022, 10, 32, Math.PI * 2 - 1.1), leather); arc.rotation.z = -Math.PI / 2 + 0.55; sport.add(arc);
    const sbar = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.036, 0.036), leather); sbar.position.y = -0.137; sport.add(sbar);
    this.swVariants = { round, yoke, sport };
    yoke.visible = false; sport.visible = false;
    this.steeringWheel.add(round, yoke, sport, swHub, swSpoke, swSpokeB, swMark, swLogo);
    // Daumenauflagen (dicker) bei 9 und 3 Uhr
    for (const sx of [-1, 1]) { const tg = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.027, 10, 10, 0.75), leather); tg.rotation.z = sx > 0 ? -0.375 : Math.PI - 0.375; this.steeringWheel.add(tg); }
    // Hände in Handschuhen (9-und-3-Uhr-Haltung): greifen den Kranz, drehen mit, greifen bei großen Winkeln um.
    // Unterarme laufen zu festen Ellbogen-Punkten (werden pro Bild ausgerichtet). Nur in der Ego-Sicht sichtbar.
    {
      const glove = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.65 });
      const cuff = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.8 });
      const sleeve = new THREE.MeshStandardMaterial({ color: 0x3b4049, roughness: 0.9 });
      this.hands = new THREE.Group(); this.hands.visible = false; this.handList = [];
      for (const sx of [-1, 1]) {
        const pivot = new THREE.Group();                 // dreht um die Lenkradachse (liegt in der Lenkrad-Ebene)
        const hand = new THREE.Group(); hand.position.set(sx * 0.16, 0, 0); hand.scale.setScalar(1.25); pivot.add(hand);
        const palm = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.08, 0.04), glove); palm.position.set(sx * 0.01, 0, 0.028); hand.add(palm);
        for (let f = 0; f < 4; f++) {                     // Finger umschließen den Kranz
          const fg = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.009, 6, 10, Math.PI * 1.15), glove);
          fg.rotation.set(0, Math.PI / 2, Math.PI * 0.42); fg.position.set(sx * 0.003, 0.028 - f * 0.019, 0); hand.add(fg);
        }
        const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.035, 4, 8), glove); thumb.position.set(-sx * 0.01, 0.04, 0.018); thumb.rotation.z = sx * 0.9; hand.add(thumb);
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.029, 0.03, 12), cuff); c.rotation.x = Math.PI / 2; c.position.set(sx * 0.012, -0.005, 0.06); hand.add(c);
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.034, 1, 14).translate(0, 0.5, 0), sleeve);
        this.hands.add(pivot); body.add(arm); arm.visible = false;
        this.handList.push({ sx, pivot, hand, arm, grip: 0, elbow: new THREE.Vector3(-0.33 + sx * 0.27, 0.66, 0.32) });
      }
    }
    body.add(this.steeringWheel);
    this.buildWindshieldRain(body);
    // Hände-Gruppe liegt wie das Lenkrad (gleiche Lage/Neigung), dreht aber selbst
    this.hands.position.copy(this.steeringWheel.position); this.hands.rotation.x = this.steeringWheel.rotation.x; this.hands.scale.copy(this.steeringWheel.scale); body.add(this.hands);

    // Displays als Canvas-Texturen (werden nur im Cockpit-Modus aktualisiert)
    const makeScreen = (w, h, pw, ph) => {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      return { cv, ctx: cv.getContext('2d'), tex, mesh };
    };
    this.cluster = makeScreen(256, 96, 0.26, 0.0975);
    this.cluster.mesh.position.set(-0.33, 0.905, -0.575); this.cluster.mesh.rotation.x = -0.25;
    body.add(this.cluster.mesh);
    this.center = makeScreen(256, 160, 0.27, 0.169);
    this.center.mesh.position.set(0, 0.9, -0.47); this.center.mesh.rotation.x = -0.55;
    body.add(this.center.mesh);
    this.screenStyle = { accent: '#36e0ff', bg: '#04111a' };   // Phase 9: Display-Design wählbar

    // ---------- Plasma-Düsen (Boost) und Hubdüsen (Fliegen) ----------
    this.fxTime = { value: 0 };
    const plasmaMat = (a, b) => new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      uniforms: { uTime: this.fxTime, uPower: { value: 0 }, uA: { value: new THREE.Color(...a) }, uB: { value: new THREE.Color(...b) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uTime; uniform float uPower; uniform vec3 uA; uniform vec3 uB; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y); }
        void main(){ float t = 1.0 - vUv.y; float fl = n(vec2(vUv.x * 9.0, vUv.y * 6.0 - uTime * 20.0));
          float a = pow(t, 1.5) * (0.5 + 0.7 * fl) * uPower; vec3 c = mix(uB, uA, pow(t, 3.0));
          gl_FragColor = vec4(c * a * 1.8, a); }`,
    });
    this.boostMat = plasmaMat([1.0, 1.0, 1.0], [0.15, 0.55, 1.6]);
    this.jetMat = plasmaMat([0.9, 1.0, 1.0], [0.1, 1.2, 0.8]);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, metalness: 0.9, roughness: 0.3 });
    this.nozzleGlow = new THREE.MeshBasicMaterial({ color: 0x103040, toneMapped: false });
    this.flames = []; this.nozzles = [];
    for (const sx of [-0.42, 0.42]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.035, 8, 20), ringMat);
      ring.position.set(sx, 0.4, 2.24); body.add(ring);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.1, 16), this.nozzleGlow); disc.position.set(sx, 0.4, 2.235); disc.rotation.y = Math.PI; body.add(disc);
      const fl = new THREE.Mesh(new THREE.ConeGeometry(0.14, 1.7, 16, 1, true).translate(0, 0.85, 0).rotateX(Math.PI / 2), this.boostMat);
      fl.position.set(sx, 0.4, 2.27); fl.visible = false; fl.renderOrder = 6; body.add(fl);
      this.flames.push(fl); this.nozzles.push(fl);
      // Volumetrisch wirkende Flamme: Kette kamera-zugewandter Sprites (von hinten voll sichtbar),
      // weißblauer Kern → blaue Stoßdiamanten → orange-rote Spitze; flackert pro Bild
      const stack = [];
      for (let k = 0; k < 9; k++) {
        const sm = new THREE.SpriteMaterial({ map: flameTex(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0 });
        const sp = new THREE.Sprite(sm); sp.position.set(sx, 0.4, 2.32 + k * 0.2); sp.renderOrder = 7; sp.visible = false; body.add(sp);
        stack.push(sp);
      }
      this.flameStacks = this.flameStacks || []; this.flameStacks.push(stack);
    }
    this.jets = []; this.jetPads = [];
    this.jetGlow = new THREE.MeshBasicMaterial({ color: 0x0a2018, toneMapped: false });
    for (const [jx, jz] of [[-0.62, -1.25], [0.62, -1.25], [-0.62, 1.3], [0.62, 1.3]]) {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(0.16, 18), this.jetGlow); pad.rotation.x = Math.PI / 2; pad.position.set(jx, 0.165, jz); body.add(pad);
      const jet = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.3, 14, 1, true).translate(0, 0.65, 0).rotateX(Math.PI), this.jetMat);
      jet.position.set(jx, 0.16, jz); jet.visible = false; jet.renderOrder = 6; body.add(jet);
      this.jets.push(jet);
    }
    this.boostLight = q.headlights ? new THREE.PointLight(0x5cc8ff, 0, 9, 1.8) : null;
    if (this.boostLight) { this.boostLight.position.set(0, 0.45, 2.8); body.add(this.boostLight); }
    this.jetLight = q.headlights ? new THREE.PointLight(0x5cffc0, 0, 7, 1.6) : null;
    if (this.jetLight) { this.jetLight.position.set(0, -0.2, 0); body.add(this.jetLight); }
    this.flyBlend = 0; this.boostBlend = 0;

    body.position.y = -cfg.cgHeight;

    // ---------- Räder ----------
    this.wheels = [];
    const tireGeo = new THREE.CylinderGeometry(R, R, cfg.wheelWidth, 28, 1).rotateZ(Math.PI / 2);
    const sideWallGeo = new THREE.TorusGeometry(R - 0.035, 0.035, 6, 28).rotateY(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, cfg.wheelWidth + 0.004, 24, 1, true).rotateZ(Math.PI / 2);
    const faceGeo = new THREE.CircleGeometry(0.24, 24).rotateY(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(0.02, 0.44, 0.045);
    const discGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.025, 20).rotateZ(Math.PI / 2);
    const calGeo = new THREE.BoxGeometry(0.07, 0.11, 0.2);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 });
    // Lauffläche mit Profil + Reifenflanke mit Schriftzug (Canvas-Texturen)
    const treadMat = new THREE.MeshStandardMaterial({ map: makeTreadTexture(), roughness: 0.95 });
    const wallMat = new THREE.MeshStandardMaterial({ map: makeSidewallTexture(R), roughness: 0.88 });
    const tireMats = [treadMat, wallMat, wallMat];
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.9, roughness: 0.25 });
    const faceMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.6, roughness: 0.5 });
    // Bremsscheiben: glühen nach harten Bremsungen orange-rot (Wärmemodell in update)
    const discMat = this.discMat = new THREE.MeshStandardMaterial({ color: 0x777b80, metalness: 0.8, roughness: 0.4, emissive: 0xff3300, emissiveIntensity: 0 });
    this.discHeat = 0;
    const calMat = new THREE.MeshStandardMaterial({ color: 0xd9a01e, roughness: 0.35, metalness: 0.3 });   // gelbe Keramik-Bremssättel

    for (const wd of cfg.wheels) {
      const side = wd.x < 0 ? -1 : 1;
      const pivot = new THREE.Group();            // Federweg + Lenkung
      const spin = new THREE.Group();             // Raddrehung
      pivot.add(spin);
      const tire = new THREE.Mesh(tireGeo, tireMats); tire.castShadow = true; spin.add(tire);
      for (const o of [-1, 1]) { const sw = new THREE.Mesh(sideWallGeo, tireMat); sw.position.x = o * cfg.wheelWidth * 0.42; spin.add(sw); }
      const rimGrp = new THREE.Group(); spin.add(rimGrp);      // Felge (Design austauschbar)
      const disc = new THREE.Mesh(discGeo, discMat); disc.position.x = side * 0.02; spin.add(disc);
      const cal = new THREE.Mesh(calGeo, calMat); cal.position.set(side * 0.03, 0.12, wd.front ? 0.1 : -0.1); pivot.add(cal);
      this.root.add(pivot);
      this.wheels.push({ pivot, spin, x: wd.x, z: wd.z, rimGrp, side });
    }
    this.rimMat = rimMat; this.faceMat = faceMat; this.rimBarrelGeo = rimGeo; this.faceGeo = faceGeo;
    this.spokeGeos = { sport: spokeGeo, thin: new THREE.BoxGeometry(0.014, 0.44, 0.026), fin: new THREE.BoxGeometry(0.018, 0.17, 0.05) };
    this.capGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.02, 12).rotateZ(Math.PI / 2);
    this.buildRims('sport5'); this._rimStyle = 'sport5';
  }

  /** Optik aus dem Physikzustand aktualisieren. */
  /** Ego-Sicht an/aus: Hände/Unterarme nur von innen sichtbar. */
  setCockpit(on) {
    if (this.hands.visible === on) return;
    this.hands.visible = on; this.cockpitOnly.visible = on; if (this.canopyMesh) this.canopyMesh.visible = !on; for (const h of this.handList) h.arm.visible = false;
  }

  /** Hände am Lenkrad: drehen mit; über ±100° wird umgegriffen (Hand gleitet zurück Richtung 9/3 Uhr). */
  updateHands(sw, dt) {
    const tmpA = this._ha || (this._ha = new THREE.Vector3()), up = this._hu || (this._hu = new THREE.Vector3(0, 1, 0));
    for (const h of this.handList) {
      // gewünschter Griff relativ zum Lenkrad: so, dass die Hand (Welt) höchstens ±100° von der Grundhaltung abweicht
      const rel = sw - h.grip;
      if (Math.abs(rel) > 1.75) h.gripTarget = sw - Math.sign(rel) * 0.35;
      if (h.gripTarget !== undefined) {
        h.grip += clamp(h.gripTarget - h.grip, -dt * 9, dt * 9);
        if (Math.abs(h.gripTarget - h.grip) < 1e-3) h.gripTarget = undefined;
      }
      if (Math.abs(sw) < 0.3 && h.gripTarget === undefined) h.grip += clamp(0 - h.grip, -dt * 3, dt * 3);
      h.pivot.rotation.z = sw - h.grip;
      // Unterarm vom Handgelenk zum Ellbogen
      h.pivot.updateWorldMatrix(true, false);
      h.hand.getWorldPosition(tmpA); h.arm.parent.worldToLocal(tmpA);
      tmpA.z += 0.06;
      const d = h.elbow.clone().sub(tmpA), L = d.length();
      h.arm.position.copy(tmpA); h.arm.scale.set(1, L, 1);
      h.arm.quaternion.setFromUnitVectors(up, d.normalize());
      h.arm.visible = true;
    }
  }

  update(vehicle, dt) {
    const cfg = this.cfg;
    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheels[i], m = this.wheels[i];
      // Federweg glätten (Optik), Rad sitzt unter dem Aufhängungspunkt
      const len = w.grounded ? w.suspLen : cfg.suspension.restLength;
      m.len = m.len === undefined ? len : damp(m.len, len, 40, dt);
      // Beim Fliegen klappen die Räder flach nach innen unter die Karosserie
      const fb = this.flyBlend, side = m.x < 0 ? -1 : 1;
      m.pivot.position.set(m.x - side * 0.2 * fb, cfg.mountY - m.len + 0.14 * fb, m.z);
      m.pivot.rotation.set(0, w.steer * (1 - fb), side * fb * Math.PI / 2);
      w.spin -= w.omega * dt;
      m.spin.rotation.x = w.spin % (Math.PI * 2);
    }
    this.steeringWheel.rotation.z = vehicle.swAngle;   // echter Lenkradwinkel (1:1 wie das Touch-Lenkrad)
    if (this.hands.visible) this.updateHands(vehicle.swAngle || 0, dt);
    this.tailMat.emissiveIntensity = vehicle.braking ? 4.5 : 0.9;
    // Schmutz: Offroad bei Tempo → mehr, Regen → abwaschen
    if (dt > 0 && vehicle.wheels) {
      let off = 0; for (const w of vehicle.wheels) if (w.grounded && w.grip < 0.95) off++;
      this.dirt = clamp((this.dirt || 0) + (off >= 2 ? Math.min(vehicle.speed || 0, 25) * 0.0035 : 0) * dt - (this.rainWash || 0) * 0.025 * dt, 0, 1);
      this.dirtU.value = this.dirt;
    }
    // Bremsenergie heizt die Scheiben auf, Fahrtwind kühlt sie (glühen erst ab starker Hitze)
    if (dt > 0 && this.discMat) {
      this.discHeat += ((vehicle.brake || 0) * (vehicle.speed || 0) * 0.013 - this.discHeat * (0.12 + (vehicle.speed || 0) * 0.004)) * dt;
      this.discHeat = Math.max(0, this.discHeat);
      this.discMat.emissiveIntensity = smoothstep(0.35, 1.3, this.discHeat) * 2.5;
    }
    // Düsen
    this.fxTime.value += dt;
    const wantFly = vehicle.flying && !(vehicle.landing && vehicle.altitude < 3) ? 1 : 0;
    this.flyBlend = approach(this.flyBlend, wantFly, dt * 1.8);
    this.boostBlend = damp(this.boostBlend, vehicle.boosting ? 1 : 0, 12, dt);
    const bp = this.boostBlend * (0.85 + 0.15 * Math.sin(this.fxTime.value * 50));
    this.boostMat.uniforms.uPower.value = bp;
    for (const f of this.flames) { f.visible = bp > 0.02; f.scale.set(1, 1, 0.5 + bp * 1.1); }
    if (this.flameStacks) {
      const t = this.fxTime.value, len = 0.75 + bp * 0.6 + clamp((vehicle.speed || 0) / 80, 0, 0.5);
      this.flameStacks.forEach((stack, si) => stack.forEach((sp, k) => {
        const u = k / (stack.length - 1);                          // 0 = Düse, 1 = Spitze
        sp.visible = bp > 0.02;
        if (!sp.visible) return;
        const flick = 0.75 + 0.25 * Math.sin(t * (41 + k * 7) + si * 2.1 + k) + (Math.random() - 0.5) * 0.25;
        const diamond = 0.6 + 0.4 * Math.max(0, Math.cos(u * Math.PI * 7));            // Stoßdiamanten
        sp.position.z = 2.3 + u * 1.9 * len + (Math.random() - 0.5) * 0.04;
        sp.position.y = 0.4 + u * u * 0.08 * Math.sin(t * 9 + si);                     // Spitze züngelt
        const sz = (0.34 - u * 0.12 + u * u * 0.22) * (0.8 + bp * 0.4) * flick;
        sp.scale.set(sz, sz, 1);
        // Farbe: Kern weißblau, Mitte kräftig blau, Spitze orange-rot (Verbrennung an der Luft)
        const c = sp.material.color;
        if (u < 0.35) c.setRGB(lerp(1.6, 0.5, u / 0.35), lerp(1.8, 1.1, u / 0.35), 2.2);
        else if (u < 0.7) c.setRGB(lerp(0.5, 1.2, (u - 0.35) / 0.35), lerp(1.1, 0.55, (u - 0.35) / 0.35), lerp(2.2, 0.5, (u - 0.35) / 0.35));
        else c.setRGB(lerp(1.2, 0.9, (u - 0.7) / 0.3), lerp(0.55, 0.18, (u - 0.7) / 0.3), lerp(0.5, 0.05, (u - 0.7) / 0.3));
        sp.material.opacity = bp * diamond * (1 - u * 0.65) * flick;
      }));
    }
    this.nozzleGlow.color.setRGB(0.06 + bp * 1.2, 0.18 + bp * 2.4, 0.25 + bp * 3.2);
    const jp = vehicle.flying ? (0.55 + vehicle.throttle * 0.25 + Math.max(0, vehicle.climbIn) * 0.3) * this.flyBlend : 0;
    this.jetMat.uniforms.uPower.value = jp;
    for (const j of this.jets) { j.visible = jp > 0.02; j.scale.set(1, 0.7 + jp * 0.8, 1); }
    this.jetGlow.color.setRGB(0.04 + jp * 0.6, 0.12 + jp * 2.6, 0.08 + jp * 1.6);
    if (this.boostLight) this.boostLight.intensity = bp * 14;
    if (this.jetLight) this.jetLight.intensity = jp * 10;
    this.revMat.emissiveIntensity = vehicle.reversing ? 2.5 : 0;
  }

  setHeadlights(on, intensity = 60) { for (const l of this.headLights) l.intensity = on ? intensity : 0; }

  /** Sichtbare Lichtkegel der Scheinwerfer (Dunst/Regen/Nebel verstärken sie) und Lichthöfe. */
  setBeams(k) {
    if (!this.beams) {
      this.beamU = { uOp: { value: 0 } };
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: this.beamU,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform float uOp; varying vec2 vUv; void main(){ float a = pow(vUv.y, 2.2) * uOp; gl_FragColor = vec4(vec3(0.95, 0.97, 1.0) * a, a); }',
      });
      this.beams = [];
      for (const s of [-0.62, 0.62]) {
        const b = new THREE.Mesh(new THREE.ConeGeometry(3.2, 26, 20, 1, true).translate(0, -13, 0).rotateX(Math.PI / 2), mat);
        b.position.set(s, 0.55, -2.15); b.rotation.x = -0.035; b.renderOrder = 8; b.frustumCulled = false;
        this.body.add(b); this.beams.push(b);
      }
      const glowTex = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
      this.glowSprites = [];
      for (const [x, y, z, c, sc] of [[-0.62, 0.55, -2.2, 0xf4f8ff, 1.3], [0.62, 0.55, -2.2, 0xf4f8ff, 1.3], [-0.7, 0.72, 2.28, 0xff2030, 0.9], [0.7, 0.72, 2.28, 0xff2030, 0.9]]) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: c, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }));
        sp.position.set(x, y, z); sp.scale.setScalar(sc); this.body.add(sp); this.glowSprites.push(sp);
      }
    }
    this.beamK = k;
    for (const b of this.beams) b.visible = k > 0;
    for (const sp of this.glowSprites) { sp.visible = k > 0; sp.material.opacity = Math.min(1, k * 0.9); }
  }

  /** Dunst/Nebel/Regen machen die Lichtkegel sichtbarer. */
  /**
   * Regen auf der Frontscheibe + Scheibenwischer (Ego-Sicht).
   * Tropfen entstehen prozedural im Shader; wo ein Wischer zuletzt vorbeikam, ist die Scheibe frei
   * und füllt sich mit der Zeit wieder. Bei Tempo laufen die Tropfen nach oben weg.
   */
  buildWindshieldRain(body) {
    const U = this.rainU = { uTime: { value: 0 }, uRain: { value: 0 }, uSpeed: { value: 0 }, uWipeT: { value: 0 }, uPeriod: { value: 1.3 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: U, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uTime, uRain, uSpeed, uWipeT, uPeriod; varying vec2 vUv;
        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        // Zeit seit der Wischer zuletzt über Winkel phi (0..1 im Wischbereich) gestrichen ist
        float sinceWipe(float phi){
          float T = uPeriod, t = mod(uWipeT, T), t1 = phi * T * 0.5, t2 = T - phi * T * 0.5;
          float a = mod(t - t1, T), b = mod(t - t2, T);
          return min(a, b) + floor(uWipeT / T) * 0.0;
        }
        void main(){
          vec2 p = vUv * vec2(1.2, 0.71);                         // Meter auf der Scheibe
          // zwei Wischer, Drehpunkte unten; Wischbereich 0..2,2 rad
          float age = 99.0;
          for (int k = 0; k < 2; k++) {
            vec2 piv = vec2(k == 0 ? 0.33 : 0.85, -0.02);
            vec2 d = p - piv; float r = length(d);
            if (r < 0.62 && uWipeT > 0.0) { float ang = atan(d.y, -d.x); float phi = clamp(ang / 2.2, 0.0, 1.0); if (ang > -0.1 && ang < 2.3) age = min(age, sinceWipe(phi)); }
          }
          vec2 flow = vec2(0.0, uTime * clamp(uSpeed / 45.0, 0.0, 1.2) * 0.35);   // Fahrtwind schiebt Tropfen nach oben
          vec2 g = (p - flow) * vec2(20.0, 20.0); vec2 id = floor(g), f = fract(g) - 0.5;
          float rnd = h21(id), born = h21(id + 7.3) * 2.5 / max(uRain, 0.05);   // dichter bei starkem Regen
          float on = step(born, age) * step(0.15, rnd);
          vec2 o = (vec2(h21(id + 1.7), h21(id + 3.1)) - 0.5) * 0.5;
          float rad = 0.12 + rnd * 0.22, dist = length(f - o);
          float drop = smoothstep(rad, rad * 0.55, dist) * on;
          float rim = smoothstep(rad * 0.55, rad * 0.9, dist) * drop;
          // Tropfen: dunkler Rand, heller Glanzpunkt oben links (wirkt wie Lichtbrechung)
          float spec = smoothstep(rad * 0.35, 0.0, length(f - o + vec2(rad * 0.3, -rad * 0.3))) * on;
          vec3 col = mix(vec3(0.7, 0.75, 0.8), vec3(0.08, 0.1, 0.12), rim) + spec * 0.8;
          float alpha = (drop * 0.55 + spec * 0.5) * clamp(uRain * 1.5, 0.0, 1.0);
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    const glassRain = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.71), mat);
    glassRain.position.set(0, 1.09, -0.49); glassRain.rotation.x = 0.905; glassRain.renderOrder = 5;
    glassRain.visible = false; body.add(glassRain); this.glassRain = glassRain;
    // Wischerarme (liegen unten auf der Scheibe, schwenken bei Regen)
    this.wipers = [];
    const armMat = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.5, metalness: 0.4 });
    for (const px of [0.33, 0.85]) {
      const piv = new THREE.Group(); piv.position.set(-0.6 + px - 0.03, -0.355 + 0.02, 0.012);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.014, 0.012), armMat); arm.position.x = -0.3; piv.add(arm);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.02), armMat); blade.position.set(-0.3, 0, 0.012); piv.add(blade);
      glassRain.add(piv); this.wipers.push(piv);
    }
    this.wipeT = 0;
  }

  /** Pro Bild: Regenstärke, Tempo; Wischer laufen, sobald es regnet. */
  updateRain(dt, rain, speed, cockpit) {
    if (!this.rainU) return;
    const U = this.rainU;
    U.uTime.value += dt; U.uRain.value = rain; U.uSpeed.value = speed; this.rainWash = rain;
    this.glassRain.visible = cockpit && rain > 0.02;
    if (rain > 0.05) { U.uPeriod.value = rain > 0.6 ? 1.0 : 1.5; this.wipeT += dt; }
    else if (this.wipeT % U.uPeriod.value > 0.02) this.wipeT += dt;   // Wischer in Ruhelage fahren
    U.uWipeT.value = this.wipeT;
    const T = U.uPeriod.value, t = this.wipeT % T, ph = t < T / 2 ? t / (T / 2) : 2 - t / (T / 2);
    for (const w of this.wipers) w.rotation.z = -ph * 2.2;
  }

  setBeamHaze(h) { if (this.beamU) this.beamU.uOp.value = (this.beamK || 0) * 0.045 * h; }

  /** Fahrer-Display (Tempo, Gang, Leistung) und Mittel-Display (g-Meter). */
  updateScreens(vehicle) {
    const st = this.screenStyle;
    // Fahrer-Display
    let c = this.cluster.ctx, W = 256, H = 96;
    c.fillStyle = st.bg; c.fillRect(0, 0, W, H);
    const kmh = Math.round(Math.abs(vehicle.forwardSpeed) * 3.6);
    c.fillStyle = '#fff'; c.font = 'bold 46px -apple-system, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(kmh), W / 2, 42);
    c.font = '600 12px sans-serif'; c.fillStyle = 'rgba(255,255,255,0.55)'; c.fillText('KM/H', W / 2, 74);
    const [g, sub] = vehicle.drivetrain.label();
    c.font = 'bold 30px sans-serif'; c.fillStyle = st.accent; c.fillText(g + sub, 32, 46);
    // Leistungsbalken
    const pw = clamp(vehicle.throttle * (0.4 + vehicle.drivetrain.rpm / vehicle.cfg.motor.redline), 0, 1);
    c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(196, 20, 12, 56);
    c.fillStyle = vehicle.braking ? '#ff3b4e' : st.accent; c.fillRect(196, 76 - 56 * pw, 12, 56 * pw);
    c.fillStyle = 'rgba(255,255,255,0.6)'; c.font = '600 10px sans-serif'; c.fillText('kW', 226, 50);
    this.cluster.tex.needsUpdate = true;
    // Mittel-Display: g-Meter + Fahrmodus
    c = this.center.ctx; W = 256; H = 160;
    c.fillStyle = st.bg; c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = 1.5;
    for (const r of [22, 44, 66]) { c.beginPath(); c.arc(84, 80, r, 0, Math.PI * 2); c.stroke(); }
    c.beginPath(); c.moveTo(18, 80); c.lineTo(150, 80); c.moveTo(84, 14); c.lineTo(84, 146); c.stroke();
    const gx = 84 + clamp(vehicle.latAccel, -1.5, 1.5) * 44, gy = 80 - clamp(vehicle.longAccel, -1.5, 1.5) * 44;
    c.fillStyle = st.accent; c.beginPath(); c.arc(gx, gy, 7, 0, Math.PI * 2); c.fill();
    c.textAlign = 'left'; c.fillStyle = '#fff'; c.font = 'bold 15px sans-serif'; c.fillText('VOLTARA', 160, 30);
    c.font = '600 11px sans-serif'; c.fillStyle = 'rgba(255,255,255,0.6)';
    c.fillText(vehicle.tractionControl ? 'Fahrhilfen AN' : 'Fahrhilfen AUS', 160, 58);
    c.fillText('g ' + Math.hypot(vehicle.latAccel, vehicle.longAccel).toFixed(2), 160, 80);
    c.fillText('Akku 87 %', 160, 102);
    c.fillStyle = st.accent; c.fillRect(160, 112, 70, 6);
    this.center.tex.needsUpdate = true;
  }
}

// ============================== SkidMarks ==============================
/** Reifenspuren als Ringpuffer aus Vierecken in einer Geometrie. */
class SkidMarks {
  constructor(scene, max = 1600) {
    this.max = max; this.next = 0;
    const pos = new Float32Array(max * 4 * 3);
    const alpha = new Float32Array(max * 4);
    const idx = [];
    for (let i = 0; i < max; i++) { const b = i * 4; idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(0.04,0.04,0.045, vA * 0.6); }',
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.last = [null, null, null, null];
    this.dirty = false;
  }

  /** Pro Rad aufrufen; legt Segmente, solange das Rad rutscht. */
  track(i, wheel, vehicle, world) {
    const active = wheel.grounded && wheel.sliding && vehicle.speed > 2;
    if (!active) { this.last[i] = null; return; }
    const p = wheel.contact;
    const rx = vehicle._v[0].set(1, 0, 0).applyQuaternion(vehicle.quat);
    const hw = 0.13;
    const y = world.sample(p.x, p.z) + 0.03;
    const cur = { lx: p.x - rx.x * hw, lz: p.z - rx.z * hw, rx: p.x + rx.x * hw, rz: p.z + rx.z * hw, y, a: clamp(0.35 + wheel.slideAmount, 0, 1) };
    const prev = this.last[i];
    if (prev && Math.hypot(cur.lx - prev.lx, cur.lz - prev.lz) > 0.35) {
      const pos = this.mesh.geometry.attributes.position.array;
      const al = this.mesh.geometry.attributes.alpha.array;
      const b = this.next * 4;
      pos.set([prev.lx, prev.y, prev.lz, prev.rx, prev.y, prev.rz, cur.lx, cur.y, cur.lz, cur.rx, cur.y, cur.rz], b * 3);
      al.set([prev.a, prev.a, cur.a, cur.a], b);
      this.next = (this.next + 1) % this.max;
      this.dirty = true;
      this.last[i] = cur;
    } else if (!prev) this.last[i] = cur;
  }

  flush() {
    if (!this.dirty) return;
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.alpha.needsUpdate = true;
    this.dirty = false;
  }
}

export { CarModel, SkidMarks };
