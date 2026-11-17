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
      ? new THREE.MeshPhysicalMaterial({ color: paintCol, metalness: 0.12, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03 })
      : new THREE.MeshStandardMaterial({ color: paintCol, metalness: 0.12, roughness: 0.28 });
    this.paint.envMapIntensity = 0.75;
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
    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.016, 6, 32, Math.PI), black);
    frame.rotation.y = Math.PI / 2; frame.position.set(0, 0.8, 0.04); frame.scale.set(1, 0.48, 1.25);
    body.add(frame);

    // Unterboden, Splitter, Diffusor, Seitenschweller
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; body.add(m); return m; };
    add(new THREE.BoxGeometry(1.7, 0.06, 3.9), black, 0, 0.2, 0);
    add(new THREE.BoxGeometry(1.5, 0.025, 0.3), carbon, 0, 0.19, -2.0);              // Frontsplitter
    add(new THREE.BoxGeometry(1.3, 0.04, 0.32), carbon, 0, 0.23, 1.9, 0.22);          // Diffusor
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.06, 0.08, 1.6), carbon, s * 0.97, 0.26, 0);
    // Außenspiegel
    const mirrorGeo = new THREE.SphereGeometry(1, 14, 10);
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.14, 0.025, 0.05), black, s * 0.97, 0.84, -0.62, 0, 0, s * 0.2);
      const m = add(mirrorGeo, this.paint, s * 1.06, 0.87, -0.6); m.scale.set(0.07, 0.05, 0.1);
      const g = add(new THREE.PlaneGeometry(0.1, 0.07), black, s * 1.06, 0.87, -0.5, 0, 0, 0); g.rotation.y = 0; g.scale.set(1, 1, 1);
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
    add(new THREE.BoxGeometry(1.22, 0.16, 0.34), interior, 0, 0.74, -0.6);
    add(new THREE.BoxGeometry(1.24, 0.045, 0.4), leather, 0, 0.835, -0.62, 0.08);
    add(new THREE.BoxGeometry(0.36, 0.05, 0.13), leather, -0.33, 0.95, -0.62, -0.15);
    add(new THREE.BoxGeometry(1.1, 0.012, 0.012), this.ambientMat, 0, 0.8, -0.425).castShadow = false;
    // Mittelkonsole mit Wählhebel
    add(new THREE.BoxGeometry(0.18, 0.2, 0.95), interior, 0, 0.6, -0.02);
    add(new THREE.BoxGeometry(0.16, 0.012, 0.8), alu, 0, 0.705, -0.02);
    add(new THREE.CylinderGeometry(0.014, 0.018, 0.05, 12), alu, 0, 0.73, -0.12);
    // Türverkleidungen mit Ambientelicht-Leiste
    for (const sx of [-1, 1]) {
      add(new THREE.BoxGeometry(0.05, 0.26, 1.25), leather, sx * 0.6, 0.66, 0.0);
      add(new THREE.BoxGeometry(0.012, 0.012, 1.1), this.ambientMat, sx * 0.574, 0.76, 0.0).castShadow = false;
      add(new THREE.BoxGeometry(0.05, 0.03, 0.3), alu, sx * 0.574, 0.7, -0.15);     // Türöffner
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
    this.steeringWheel.position.set(-0.33, 0.83, -0.32);
    this.steeringWheel.rotation.x = -0.35;
    const swRim = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.021, 10, 32), leather);
    const swHub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 16).rotateX(Math.PI / 2), carbon);
    const swSpoke = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.028, 0.02), carbon);
    const swSpokeB = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.15, 0.02), carbon); swSpokeB.position.y = -0.08;
    const swMark = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.03, 0.03), new THREE.MeshBasicMaterial({ color: 0x36e0ff }));
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
    body.add(this.steeringWheel);

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
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.9, roughness: 0.25 });
    const faceMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.6, roughness: 0.5 });
    const discMat = new THREE.MeshStandardMaterial({ color: 0x777b80, metalness: 0.8, roughness: 0.4 });
    const calMat = new THREE.MeshStandardMaterial({ color: 0x36e0ff, roughness: 0.4, emissive: 0x062030 });

    for (const wd of cfg.wheels) {
      const side = wd.x < 0 ? -1 : 1;
      const pivot = new THREE.Group();            // Federweg + Lenkung
      const spin = new THREE.Group();             // Raddrehung
      pivot.add(spin);
      const tire = new THREE.Mesh(tireGeo, tireMat); tire.castShadow = true; spin.add(tire);
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
    this.steeringWheel.rotation.z = vehicle.steerAngle * cfg.steer.wheelToSteeringWheel * 0.5;
    this.tailMat.emissiveIntensity = vehicle.braking ? 4.5 : 0.9;
    // Düsen
    this.fxTime.value += dt;
    const wantFly = vehicle.flying && !(vehicle.landing && vehicle.altitude < 3) ? 1 : 0;
    this.flyBlend = approach(this.flyBlend, wantFly, dt * 1.8);
    this.boostBlend = damp(this.boostBlend, vehicle.boosting ? 1 : 0, 12, dt);
    const bp = this.boostBlend * (0.85 + 0.15 * Math.sin(this.fxTime.value * 50));
    this.boostMat.uniforms.uPower.value = bp;
    for (const f of this.flames) { f.visible = bp > 0.02; f.scale.set(1, 1, 0.5 + bp * 1.1); }
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
