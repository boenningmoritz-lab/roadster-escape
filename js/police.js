import * as THREE from 'three';
import { clamp, lerp, damp } from './config.js';
import { mergeParts, makeBlobTexture } from './world/world.js';
import { Haptics, toast } from './input.js';
import { makeTrafficVariant } from './world/traffic.js';

// ============================== Spielstand ==============================
/** Geld, Fortschritt, Upgrades (Phase 9) – dauerhaft in localStorage. */
const SaveData = {
  KEY: 'roadsterEscape.save.v1',
  data: { money: 0, bestEscape: {}, stats: { escapes: 0, busted: 0 } },
  load() { try { Object.assign(this.data, JSON.parse(localStorage.getItem(this.KEY) || '{}')); } catch (e) { /* privat */ } },
  save() { try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); } catch (e) { /* voll/blockiert */ } },
  addMoney(n) { this.data.money = Math.max(0, Math.round(this.data.money + n)); this.save(); },
};
SaveData.load();
const fmtMoney = (n) => Math.round(n).toLocaleString('de-DE') + ' €';

// ============================== Polizei ==============================
// Polizei-Stufen. bust = Sekunden, die die Polizei dicht bei einem (langsamen) Spieler sein muss.
// spikes = Nagelbänder, blockEvery = Abstand der Straßensperren (s), maxStars = höchste Fahndungsstufe.
const POLICE_LEVELS = {
  easy:    { name: 'Leicht',  count: 1,  vmax: 42, accel: 5.5, predict: 0.4, encircle: false, ram: 0.12, block: false, spikes: false, heli: false, escape: 6,  reward: 6,  bust: 7,   blockEvery: 60, maxStars: 3 },
  normal:  { name: 'Normal',  count: 2,  vmax: 52, accel: 7,   predict: 0.8, encircle: false, ram: 0.3,  block: false, spikes: false, heli: false, escape: 8,  reward: 12, bust: 5,   blockEvery: 50, maxStars: 4 },
  hard:    { name: 'Schwer',  count: 4,  vmax: 66, accel: 9,   predict: 1.2, encircle: true,  ram: 0.55, block: true,  spikes: true,  heli: false, escape: 11, reward: 25, bust: 4.7,   blockEvery: 40, maxStars: 5 },
  extreme: { name: 'Extrem',  count: 6,  vmax: 78, accel: 10.5, predict: 1.6, encircle: true, ram: 0.75, block: true,  spikes: true,  heli: true,  escape: 14, reward: 45, bust: 4.4, blockEvery: 32, maxStars: 5 },
  insane:  { name: 'Insane',  count: 10, vmax: 92, accel: 12.5, predict: 2.6, encircle: true, ram: 1.0,  block: true,  spikes: true,  heli: true,  escape: 18, reward: 80, bust: 4,   blockEvery: 25, maxStars: 5 },
};

/** Großer, fliegender Luxus-SUV der Polizei (frei erfunden, keine echte Marke). */
function makePoliceGeometry() {
  const L = 5.3, W = 2.06, H = 1.92;
  const DARK = [0.05, 0.08, 0.14], SILVER = [0.86, 0.88, 0.9], GLASS = [0.05, 0.06, 0.08], CHROME = [0.75, 0.77, 0.8], TIRE = [0.05, 0.05, 0.05];
  const parts = [];
  const ext = (pts, width, bevel) => {
    const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) sh.lineTo(p[0], p[1]);
    const g = new THREE.ExtrudeGeometry(sh, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 2, curveSegments: 2 });
    g.translate(0, 0, -(width - 2 * bevel) / 2); g.rotateY(-Math.PI / 2); g.computeVertexNormals(); return g;
  };
  // Karosserie, Glashaus, Räder und Innenraum (mit Fahrer) aus dem gerundeten Loft-Modell der Verkehrsautos (SUV-Form),
  // umgefärbt: Lack dunkelblau, Türen silbern; Glas wird getönt-durchsichtig gezeichnet
  const V = makeTrafficVariant('suv', { L, W, H, hood: 1.25, trunk: 0.25, wr: 0.42, mass: 2600 });
  { const col = V.body.attributes.color, pm = V.body.attributes.paint, c = new THREE.Color();
    for (let i = 0; i < col.count; i++) if (pm.getX(i) > 0.5) { c.setRGB(DARK[0], DARK[1], DARK[2], THREE.SRGBColorSpace); col.setXYZ(i, c.r, c.g, c.b); } }
  parts.push({ geo: V.body });
  const glassParts = [{ geo: V.glass }];
  parts.push({ geo: new THREE.BoxGeometry(W + 0.025, 0.34, L - 1.9).translate(0, 0.72, 0.1), color: SILVER });         // silberner Türstreifen
  parts.push({ geo: new THREE.BoxGeometry(1.2, 0.48, 0.06).translate(0, 0.76, -L / 2 - 0.04), color: CHROME });         // Kühlergrill
  for (let i = 0; i < 6; i++) parts.push({ geo: new THREE.BoxGeometry(1.12, 0.02, 0.07).translate(0, 0.56 + i * 0.08, -L / 2 - 0.05), color: [0.15, 0.16, 0.18] });
  // Lichtbalken-Sockel
  parts.push({ geo: new THREE.BoxGeometry(1.3, 0.1, 0.36).translate(0, H + 0.08, -0.1), color: [0.12, 0.12, 0.14] });
  return { body: mergeParts(parts), glass: mergeParts(glassParts), L, W, H };   // mergeParts übernimmt vorhandene Vertexfarben
}

/** Schriftzug „POLIZEI“ als Textur. */
function makePoliceDecal() {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96;
  const c = cv.getContext('2d');
  c.fillStyle = '#1a3d8f'; c.fillRect(0, 0, 512, 96);
  c.fillStyle = '#ffffff'; c.font = 'bold 64px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('POLIZEI', 256, 52);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

class PoliceSystem {
  constructor(world, scene, q, sound) {
    this.w = world; this.scene = scene; this.q = q; this.sound = sound;
    this.active = false; this.units = []; this.time = 0;
    this.geo = makePoliceGeometry();
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.3 });
    this.decalMat = new THREE.MeshStandardMaterial({ map: makePoliceDecal(), roughness: 0.4, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -2 });
    this.blueA = new THREE.MeshBasicMaterial({ color: 0x1030ff, toneMapped: false });
    this.blueB = new THREE.MeshBasicMaterial({ color: 0x1030ff, toneMapped: false });
    this.headMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.tailMat = new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false });
    this.jetMat = new THREE.MeshBasicMaterial({ color: 0x40a0ff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    // Zwei echte Blaulichter für die nächsten Wagen (nachts wirkungsvoll)
    this.flashLights = q.headlights ? [0, 1].map(() => { const l = new THREE.PointLight(0x2050ff, 0, 40, 1.4); scene.add(l); return l; }) : [];
    this.heli = null;
    this._v = Array.from({ length: 6 }, () => new THREE.Vector3());
    this.ui = {
      hud: document.getElementById('chaseHud'), stars: document.getElementById('chaseStars'), status: document.getElementById('chaseStatus'),
      bust: document.getElementById('bustFill'), bustWrap: document.getElementById('bustBar'), bustTxt: document.querySelector('#bustBar span'),
    };
  }

  makeUnit() {
    const G = this.geo, grp = new THREE.Group();
    const body = new THREE.Mesh(G.body, this.bodyMat); body.castShadow = true; grp.add(body);
    if (!this.glassMat) this.glassMat = new THREE.MeshStandardMaterial({ color: 0x0d1218, roughness: 0.06, metalness: 0.4, transparent: true, opacity: 0.62, envMapIntensity: 1.4 });
    const gl = new THREE.Mesh(G.glass, this.glassMat); gl.renderOrder = 2; grp.add(gl);
    // Frontblitzer im Grill + Lichtbalken mit 3 Segmenten je Seite (Lauf-/Doppelblitz-Muster)
    if (!this.segMats) this.segMats = [0, 1, 2, 3, 4, 5].map(() => new THREE.MeshBasicMaterial({ color: 0x1030ff, toneMapped: false }));
    for (let k = 0; k < 6; k++) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.11, 0.3), this.segMats[k]);
      seg.position.set((k - 2.5) * 0.2, G.H + 0.19, -0.1); grp.add(seg);
    }
    for (const s of [-1, 1]) {
      const fl = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.03), s < 0 ? this.blueA : this.blueB); fl.position.set(s * 0.42, 0.62, -G.L / 2 - 0.08); grp.add(fl);
    }
    // Lichtschein auf der Straße (additiv, blitzt mit) – billige „Reflexion“ auch ohne echte Lichter
    if (!this.glowTex) this.glowTex = makeBlobTexture();
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: this.glowTex, color: 0x2050ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -9, polygonOffsetUnits: -9 }));
    glow.scale.set(11, 1, 11); glow.renderOrder = 2; this.scene.add(glow);
    for (const s of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.36), this.decalMat);
      d.position.set(s * (G.W / 2 + 0.025), 0.78, 0.15); d.rotation.y = s * Math.PI / 2; grp.add(d);
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.12, 0.05), this.headMat); hl.position.set(s * 0.75, 0.88, -G.L / 2 - 0.04); grp.add(hl);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.16, 0.05), this.tailMat); tl.position.set(s * 0.8, 0.95, G.L / 2 + 0.03); grp.add(tl);
    }
    const jets = [];
    for (const [x, z] of [[-0.7, -1.5], [0.7, -1.5], [-0.7, 1.5], [0.7, 1.5]]) {
      const j = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.4, 12, 1, true).translate(0, 0.7, 0).rotateX(Math.PI), this.jetMat);
      j.position.set(x, 0.25, z); j.visible = false; grp.add(j); jets.push(j);
    }
    grp.visible = false;
    this.scene.add(grp);
    if (!this.blobMat) this.blobMat = new THREE.MeshBasicMaterial({ map: makeBlobTexture(), color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 });
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.blobMat.clone());
    blob.scale.set(this.geo.W + 0.6, 1, this.geo.L + 0.8); blob.visible = false; blob.renderOrder = 1; this.scene.add(blob);
    return { grp, jets, blob, glow, pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, bank: 0, pitch: 0, mode: 'air', slot: 0, block: null, mass: 2600, flying: true };
  }

  makeHeli() {
    const grp = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x14213d, metalness: 0.5, roughness: 0.4 });
    const light = new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 0.4, roughness: 0.35 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0a1018, metalness: 0.9, roughness: 0.1 });
    const cab = new THREE.Mesh(new THREE.SphereGeometry(1.6, 18, 12).scale(1, 0.9, 1.5), light); grp.add(cab);
    const win = new THREE.Mesh(new THREE.SphereGeometry(1.62, 18, 12, 0, Math.PI * 2, 0, 1.1).scale(1, 0.9, 1.5).rotateX(-1.1), glass); win.position.set(0, 0.05, -0.2); grp.add(win);
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.5, 6, 10).rotateX(Math.PI / 2), dark); boom.position.set(0, 0.3, 4.6); grp.add(boom);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.4, 0.9), dark); fin.position.set(0, 1.0, 7.4); grp.add(fin);
    for (const s of [-1, 1]) {
      const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.6, 6).rotateX(Math.PI / 2), dark); skid.position.set(s * 1.1, -1.75, 0); grp.add(skid);
      for (const z of [-0.9, 0.9]) { const st = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 6), dark); st.position.set(s * 0.95, -1.4, z); st.rotation.z = s * 0.3; grp.add(st); }
      const d = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.34), this.decalMat); d.position.set(s * 1.55, -0.1, 0.4); d.rotation.y = s * Math.PI / 2; grp.add(d);
    }
    const rotor = new THREE.Group(); rotor.position.set(0, 1.65, 0);
    for (let k = 0; k < 4; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 6), dark); b.rotation.y = k * Math.PI / 2; b.position.set(0, 0, 0); b.translateZ(3); rotor.add(b); }
    const blur = new THREE.Mesh(new THREE.CircleGeometry(6, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.15, depthWrite: false }));
    rotor.add(blur); grp.add(rotor);
    const tail = new THREE.Group(); tail.position.set(0.15, 1.1, 7.5);
    for (let k = 0; k < 2; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.2, 0.12), dark); b.rotation.x = k * Math.PI / 2; tail.add(b); }
    grp.add(tail);
    const lbA = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.3), this.blueA); lbA.position.set(0, -1.35, -0.6); grp.add(lbA);
    // Suchscheinwerfer: echtes Spotlicht + sichtbarer Lichtkegel
    const spot = new THREE.SpotLight(0xf4f8ff, 0, 320, 0.11, 0.35, 1.0);
    spot.position.set(0, -1.4, -1.2); grp.add(spot); this.scene.add(spot.target);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const beam = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 24, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2), beamMat);
    this.scene.add(beam);
    grp.visible = false; beam.visible = false;
    this.scene.add(grp);
    return { grp, rotor, tail, spot, beam, beamMat, pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0 };
  }

  /** Verfolgung starten. */
  start(levelKey, player, camera) {
    this.stop(false);
    const D = this.D = POLICE_LEVELS[levelKey]; this.levelKey = levelKey;
    this.active = true; this.time = 0; this.lastSeen = 0; this.seen = true; this.bustT = 0; this.rams = 0; this.wanted = 1;
    this.earned = 0; this.earnAcc = 0; this.payT = 0;   // Geld pro Sekunde während der Verfolgung
    this.lastKnown = player.pos.clone(); this.blockTimer = 25;
    while (this.units.length < D.count + 8) this.units.push(this.makeUnit());
    this.extra = 0; this.spikeTimer = 20; this.bustWarned = 0; this.heliOn = false;
    for (const s of this.spikes || []) s.mesh.visible = false; this.spikes = this.spikes || [];
    this.units.forEach((u, i) => {
      u.active = i < D.count; u.grp.visible = u.active; u.slot = i; u.block = null; u.mode = 'air';
      if (u.active) this.spawnUnit(u, player, 260 + i * 40);
    });
    if (D.heli) {
      this.heliOn = true;
      if (!this.heli) this.heli = this.makeHeli();
      const h = this.heli; h.grp.visible = true; h.beam.visible = true;
      h.pos.copy(player.pos).add(this._v[0].set(-200, 90, -200)); h.vel.set(0, 0, 0);
    } else if (this.heli) { this.heli.grp.visible = false; this.heli.beam.visible = false; this.heli.spot.intensity = 0; }
    this.ui.hud.hidden = false;
    this.sound?.policeOn(true);
  }

  spawnUnit(u, player, dist) {
    const a = Math.random() * Math.PI * 2;
    const x = clamp(player.pos.x + Math.cos(a) * dist, -1850, 1850), z = clamp(player.pos.z + Math.sin(a) * dist, -1850, 1850);
    u.pos.set(x, this.w.sample(x, z) + 30, z);
    u.vel.set(0, 0, 0); u.mode = 'air'; u.flying = true;
  }

  /** Verfolgung beenden. result: 'escaped' | 'busted' | false (abgebrochen) */
  stop(result) {
    if (!this.active) return null;
    this.active = false;
    for (const u of this.units) { u.grp.visible = false; u.active = false; u.blob.visible = false; if (u.glow) u.glow.visible = false; }
    if (this.heli) { this.heli.grp.visible = false; this.heli.beam.visible = false; this.heli.spot.intensity = 0; }
    for (const l of this.flashLights) l.intensity = 0;
    for (const sp of this.spikes || []) sp.mesh.visible = false;
    this.ui.hud.hidden = true;
    this.sound?.policeOn(false);
    if (!result) return null;
    const D = this.D;
    // Restbetrag der laufenden Sekunde gutschreiben; bei Flucht zusätzlich ein Entkommen-Bonus
    const rest = Math.floor(this.earnAcc); this.earnAcc -= rest; this.earned += rest;
    const bonus = result === 'escaped' ? Math.round(D.reward * 20 * (1 + (this.wanted - 1) * 0.25)) : 0;
    if (rest + bonus) SaveData.addMoney(rest + bonus);
    const reward = this.earned + bonus;
    const st = SaveData.data.stats;
    if (result === 'escaped') { st.escapes++; const b = SaveData.data.bestEscape; b[this.levelKey] = Math.max(b[this.levelKey] || 0, Math.round(this.time)); }
    else st.busted++;
    SaveData.save();
    return { result, reward, time: this.time, wanted: this.wanted, level: D.name };
  }

  /** Sichtlinie: Entfernung, Gelände und Gebäude dazwischen. */
  canSee(from, to, range) {
    const d = from.distanceTo(to);
    if (d > range) return false;
    const n = Math.max(3, Math.ceil(d / 25));
    for (let k = 1; k < n; k++) {
      const t = k / n, x = lerp(from.x, to.x, t), y = lerp(from.y, to.y, t), z = lerp(from.z, to.z, t);
      if (this.w.sample(x, z) > y + 0.5) return false;
      if (this.w.insideBuilding(x, y, z)) return false;
    }
    return true;
  }

  update(dt, player, camera) {
    if (!this.active) return null;
    const D = this.D, w = this.w;
    this.time += dt;
    const pp = player.pos, pv = player.vel;
    // Fahndungslevel steigt mit der Zeit und mit Rammstößen
    this.wanted = clamp(1 + Math.floor(this.time / 30) + Math.floor(this.rams / 3), 1, D.maxStars);
    // Geld pro Sekunde: Stufe × Fahndungssterne; einmal pro Sekunde gutschreiben (nicht jedes Bild speichern)
    this.rate = D.reward * (1 + (this.wanted - 1) * 0.25);
    this.earnAcc += this.rate * dt;
    if ((this.payT += dt) >= 1) { this.payT = 0; const n = Math.floor(this.earnAcc); if (n > 0) { this.earnAcc -= n; this.earned += n; SaveData.addMoney(n); } }
    const boost = 1 + (this.wanted - 1) * 0.05;
    // Höhere Fahndungsstufe schaltet Taktiken frei: ★★★ Einkesseln, ★★★★ Sperren + Nagelbänder + Verstärkung, ★★★★★ Hubschrauber
    this.tact = { encircle: D.encircle || this.wanted >= 3, block: D.block || this.wanted >= 4, spikes: D.spikes || this.wanted >= 4, heli: D.heli || this.wanted >= 5 };
    const wantExtra = Math.max(0, this.wanted - 2) * Math.max(1, Math.round(D.count * 0.25));
    if (wantExtra > this.extra) {
      const free = this.units.filter((u) => !u.active && !u.block).slice(0, wantExtra - this.extra);
      for (const u of free) { u.active = true; u.grp.visible = true; u.block = null; this.spawnUnit(u, player, 320); this.extra++; }
      if (free.length) toast('Verstärkung angefordert ' + '★'.repeat(this.wanted), 1500);
    }
    if (this.tact.heli && !this.heliOn) this.enableHeli(player);
    // Sicht prüfen (4× pro Sekunde)
    this.seeT = (this.seeT || 0) - dt;
    if (this.seeT <= 0) {
      this.seeT = 0.25;
      let seen = false;
      for (const u of this.units) if (u.active && !u.block?.wait && this.canSee(u.pos, pp, 300)) { seen = true; break; }
      if (!seen && this.heli && this.heliOn && this.canSee(this.heli.pos, pp, 480)) seen = true;
      this.seen = seen;
      if (seen) { this.lastSeen = this.time; this.lastKnown.copy(pp); }
    }
    const hidden = this.time - this.lastSeen;
    if (hidden > D.escape) return this.stop('escaped');
    // Straßensperren (ab „Schwer“)
    if (this.tact.block && (this.blockTimer -= dt) <= 0) { this.blockTimer = D.blockEvery * (0.8 + Math.random() * 0.5); this.placeRoadblock(player); }
    // Nagelbänder vor dem Spieler auslegen; Überfahren zerstört die Reifen für einige Sekunden
    if (this.tact.spikes && (this.spikeTimer -= dt) <= 0) { this.spikeTimer = 22 + Math.random() * 18; this.placeSpikes(player); }
    this.updateSpikes(dt, player);
    // Einheiten bewegen
    let near = 0;
    const hs = Math.hypot(pv.x, pv.z);
    const pf = this._v[0].set(hs > 1 ? pv.x / hs : -Math.sin(player.yaw()), 0, hs > 1 ? pv.z / hs : -Math.cos(player.yaw()));
    const act = this.units.filter((u) => u.active);
    act.forEach((u, idx) => {
      if (u.block) { this.updateBlock(u, dt, player); if (u.pos.distanceTo(pp) < 8.5) near++; return; }
      const target = this._v[1];
      const known = this.seen ? pp : this.lastKnown;
      const dist = u.pos.distanceTo(known);
      const closing = Math.max(8, u.vel.length());
      const predict = clamp(dist / closing, 0, D.predict);
      target.copy(known);
      if (this.seen) target.addScaledVector(pv, predict);
      // Einkesseln: feste Plätze rund um den Spieler (vorne links/rechts, seitlich, hinten)
      if (this.tact.encircle && dist < 70 && this.seen) {
        const ang = [Math.PI * 0.25, -Math.PI * 0.25, Math.PI * 0.6, -Math.PI * 0.6, Math.PI, Math.PI * 0.85, -Math.PI * 0.85, 0.1, Math.PI * 0.4, -Math.PI * 0.4][idx % 10];
        const r = dist < 20 ? 5.5 : 9;
        const c = Math.cos(ang), s = Math.sin(ang);
        target.x += (pf.x * c - pf.z * s) * r; target.z += (pf.z * c + pf.x * s) * r;
      }
      // Rammen: kurz direkt auf den Spieler zielen
      if (dist < 14 && hs > 9 && Math.random() < D.ram * dt * 2) u.ramT = 0.8;   // nur rammen, solange der Spieler noch fährt
      if ((u.ramT = (u.ramT || 0) - dt) > 0) target.copy(pp);
      // Höhe: in Spielernähe auf die Straße herunter, sonst fliegen (über Häuser, Bäume, Wasser)
      const dirx = target.x - u.pos.x, dirz = target.z - u.pos.z, dl = Math.hypot(dirx, dirz) || 1;
      const hdist = Math.hypot(pp.x - u.pos.x, pp.z - u.pos.z);
      const gGround = w.sample(u.pos.x, u.pos.z);
      let roofHere = -1e9, blockTop = -1e9;
      for (const b of w.buildingHash.at(u.pos.x, u.pos.z)) if (u.pos.x > b.x0 - 1.5 && u.pos.x < b.x1 + 1.5 && u.pos.z > b.z0 - 1.5 && u.pos.z < b.z1 + 1.5) roofHere = Math.max(roofHere, b.top);
      for (const k of [6, 16, 32]) {
        const ax = u.pos.x + dirx / dl * k, az = u.pos.z + dirz / dl * k;
        for (const b of w.buildingHash.at(ax, az)) if (ax > b.x0 - 2.5 && ax < b.x1 + 2.5 && az > b.z0 - 2.5 && az < b.z1 + 2.5) blockTop = Math.max(blockTop, b.top);
        blockTop = Math.max(blockTop, w.sample(ax, az) + 0.5);
      }
      let treesNear = false;
      if (hdist > 22) w.treeHash?.near(u.pos.x, u.pos.z, 7, (ti) => { if (w.treeState[ti] === 0) treesNear = true; });
      let ty = !player.flying && hdist < 140 ? gGround + 0.95 : Math.max(gGround + 22, player.flying ? pp.y + (hdist < 30 ? 0 : 4) : 0);
      if (treesNear) ty = Math.max(ty, gGround + 17);
      if (roofHere > -1e8) ty = Math.max(ty, roofHere + 2);
      if (blockTop > u.pos.y - 2.5 && hdist > 35) ty = Math.max(ty, blockTop + 6);
      if (gGround < w.waterLevel) ty = Math.max(ty, w.waterLevel + 2.5);
      const hoverY = gGround + 0.95;
      u.flying = u.pos.y > hoverY + 1.6;
      // Horizontale Bewegung: Ankommen statt Überschießen
      const vmax = D.vmax * boost;
      // „Ankommen“: rechtzeitig bremsen (Bremsweg v²/2a), plus Tempo des Spielers mitnehmen
      const want = Math.min(vmax, Math.sqrt(2 * D.accel * 0.8 * dl) + Math.min(hs, vmax) * (dist < 60 ? 0.95 : 0.4));
      let dvx = dirx / dl * want - u.vel.x, dvz = dirz / dl * want - u.vel.z;
      // Abstand zu anderen Polizeiwagen
      for (const o of act) {
        if (o === u) continue;
        const ox = u.pos.x - o.pos.x, oz = u.pos.z - o.pos.z, od = Math.hypot(ox, oz);
        if (od < 7 && od > 0.01 && Math.abs(u.pos.y - o.pos.y) < 3) { dvx += ox / od * (7 - od) * 3; dvz += oz / od * (7 - od) * 3; }
      }
      const dvl = Math.hypot(dvx, dvz), maxA = D.accel * boost * dt;
      if (dvl > maxA) { dvx *= maxA / dvl; dvz *= maxA / dvl; }
      u.vel.x += dvx; u.vel.z += dvz;
      u.vel.y += clamp((ty - u.pos.y) * 1.8 - u.vel.y, -14, 14) * Math.min(1, dt * 3);
      u.pos.addScaledVector(u.vel, dt);
      const gNow = w.sample(u.pos.x, u.pos.z);
      if (u.pos.y < gNow + 0.95) { u.pos.y = gNow + 0.95; u.vel.y = Math.max(0, u.vel.y); }
      // aus Gebäuden heraus nach oben
      for (const b of w.buildingHash.at(u.pos.x, u.pos.z)) {
        if (u.pos.x > b.x0 - 1.2 && u.pos.x < b.x1 + 1.2 && u.pos.z > b.z0 - 1.2 && u.pos.z < b.z1 + 1.2 && u.pos.y < b.top + 1) { u.pos.y = b.top + 1; u.vel.y = Math.max(u.vel.y, 6); }
      }
      // Ausrichtung: in Fahrtrichtung, im Flug in die Kurve geneigt
      const sp = Math.hypot(u.vel.x, u.vel.z);
      const yawT = sp > 2 ? Math.atan2(-u.vel.x, -u.vel.z) : Math.atan2(-(pp.x - u.pos.x), -(pp.z - u.pos.z));
      let dy = yawT - u.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const turn = clamp(dy, -dt * 2.6, dt * 2.6);
      u.yaw += turn;
      const airK = clamp((u.pos.y - hoverY) / 4, 0, 1);              // nahe am Boden kaum Schräglage
      u.bank = damp(u.bank, clamp(-turn / dt * 0.2, -0.35, 0.35) * airK, 4, dt);
      u.pitch = damp(u.pitch, clamp(-u.vel.y * 0.02, -0.2, 0.2) * airK, 4, dt);
      if (u.pos.distanceTo(pp) < 8.5) near++;
      // zu weit weg / verloren → neu heranführen
      if (u.pos.distanceTo(pp) > 900) this.spawnUnit(u, player, 380);
    });
    // Festnahme: NICHT durch Berühren/Rammen, sondern erst wenn die Polizei D.bust Sekunden dicht dran ist
    // (< 6 m und ich langsamer als 25 km/h) oder ich eingekesselt bin (3 Wagen < 9 m, < 50 km/h).
    let close = 0, ring = 0;
    for (const u of act) { const d = u.pos.distanceTo(pp); if (d < 6) close++; if (d < 9) ring++; }
    const pSpeed = player.speed;
    const busting = !player.flying && ((close >= 1 && pSpeed < 25 / 3.6) || (ring >= 3 && pSpeed < 50 / 3.6));
    const prevT = this.bustT;
    this.bustT = busting ? this.bustT + dt : Math.max(0, this.bustT - dt * 0.6);      // freigekommen → läuft langsam zurück
    const left = D.bust - this.bustT;
    if (busting && prevT === 0) { Haptics.pulse(40); this.sound?.beep?.(880, 0.12); }
    if (busting && left < 1 && this.bustWarned < 1) { this.bustWarned = 1; Haptics.pulse([60, 40, 60]); this.sound?.beep?.(1320, 0.25); }
    if (left > 1.2) this.bustWarned = 0;
    if (this.bustT >= D.bust) return this.stop('busted');
    this.updateHeli(dt, player);
    this.updateVisuals(dt, camera);
    this.updateHud(hidden);
    return null;
  }

  /** Straßensperre auf der vermuteten Fluchtroute: 2–3 Wagen quer auf der Straße. */
  /** Hubschrauber nachträglich dazuholen (ab ★★★★★ auch in niedrigeren Stufen). */
  enableHeli(player) {
    this.heliOn = true;
    if (!this.heli) this.heli = this.makeHeli();
    const h = this.heli; h.grp.visible = true; h.beam.visible = true;
    h.pos.copy(player.pos).add(this._v[0].set(-200, 90, -200)); h.vel.set(0, 0, 0);
    toast('Polizeihubschrauber im Einsatz', 1500);
  }

  /** Nagelband quer über die Straße, ein Stück vor dem Spieler. */
  placeSpikes(player) {
    const hs = Math.hypot(player.vel.x, player.vel.z);
    if (player.flying || hs < 15) { this.spikeTimer = 4; return; }
    const ahead = clamp(hs * 5, 110, 260);
    const px = player.pos.x + player.vel.x / hs * ahead, pz = player.pos.z + player.vel.z / hs * ahead;
    const pose = this.w.nearestRoadPose(px, pz, player.yaw());
    if (!pose.edge || Math.hypot(pose.x - px, pose.z - pz) > 50) { this.spikeTimer = 4; return; }
    let s = this.spikes.find((k) => !k.mesh.visible);
    if (!s) {
      if (this.spikes.length >= 3) s = this.spikes[0];
      else {
        const parts = [{ geo: new THREE.BoxGeometry(1, 0.04, 0.35), color: [0.1, 0.1, 0.11] }];
        for (let i = -4.5; i <= 4.5; i += 0.5) parts.push({ geo: new THREE.ConeGeometry(0.03, 0.09, 4).translate(i / 9, 0.06, 0), color: [0.75, 0.76, 0.78] });
        const mesh = new THREE.Mesh(mergeParts(parts), new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.4 }));
        mesh.castShadow = true; this.scene.add(mesh);
        s = { mesh }; this.spikes.push(s);
      }
    }
    const W = pose.edge.C.halfW * 2 + 1;
    s.x = pose.x; s.z = pose.z; s.yaw = pose.yaw; s.half = W / 2; s.t = 0;
    // quer zur Fahrbahn über die ganze Breite (Mitte der Straße)
    const fx = -Math.sin(pose.yaw), fz = -Math.cos(pose.yaw), rx = -fz, rz = fx, lane = pose.edge.C.lanes[pose.edge.C.lanes.length - 1];
    s.x -= rx * lane; s.z -= rz * lane;
    s.mesh.position.set(s.x, this.w.sample(s.x, s.z) + 0.03, s.z); s.mesh.rotation.set(0, pose.yaw + Math.PI / 2, 0); s.mesh.scale.set(W, 1, 1);
    s.mesh.visible = true;
  }

  updateSpikes(dt, player) {
    for (const s of this.spikes) {
      if (!s.mesh.visible) continue;
      s.t += dt;
      const dx = player.pos.x - s.x, dz = player.pos.z - s.z;
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
      const along = dx * fx + dz * fz, across = Math.abs(dx * -fz + dz * fx);
      if (Math.abs(along) < 1.6 && across < s.half && !player.flying && player.pos.y - this.w.sample(player.pos.x, player.pos.z) < 1.5) {
        player.puncture = 9; Haptics.pulse([30, 20, 30, 20, 30]); this.sound?.impact?.(6);
        toast('Nagelband! Reifen platt – Grip und Tempo reduziert', 1800);
        s.mesh.visible = false;
      }
      if (s.t > 45 || Math.hypot(dx, dz) > 700) s.mesh.visible = false;
    }
  }

  placeRoadblock(player) {
    const hs = Math.hypot(player.vel.x, player.vel.z);
    if (player.flying || hs < 12) { this.blockTimer = 3; return; }
    const ahead = clamp(hs * 7, 140, 320);
    const px = player.pos.x + player.vel.x / hs * ahead, pz = player.pos.z + player.vel.z / hs * ahead;
    const pose = this.w.nearestRoadPose(px, pz, player.yaw());
    if (!pose.edge || Math.hypot(pose.x - px, pose.z - pz) > 60) { this.blockTimer = 3; return; }
    const n = this.D.count >= 6 ? 3 : 2;
    const free = this.units.filter((u) => !u.active).slice(0, n);
    const fx = -Math.sin(pose.yaw), fz = -Math.cos(pose.yaw), rx = -fz, rz = fx;
    const center = this.w.nearestRoadPose(pose.x, pose.z, pose.yaw);
    free.forEach((u, k) => {
      const off = (k - (n - 1) / 2) * 4.2 - center.edge.C.lanes[center.edge.C.lanes.length - 1] * 0;
      const x = pose.x - rx * center.edge.C.lanes[0] + rx * off, z = pose.z - rz * center.edge.C.lanes[0] + rz * off;
      u.active = true; u.grp.visible = true;
      u.block = { t: 0, x, z, yaw: pose.yaw + Math.PI / 2 + (k - 1) * 0.25, wait: false };
      u.pos.set(x, this.w.sample(x, z) + 30, z); u.vel.set(0, 0, 0); u.yaw = u.block.yaw;
    });
  }

  updateBlock(u, dt, player) {
    const b = u.block; b.t += dt;
    const g = this.w.sample(b.x, b.z);
    u.pos.x = damp(u.pos.x, b.x, 3, dt); u.pos.z = damp(u.pos.z, b.z, 3, dt);
    u.pos.y = damp(u.pos.y, g + 0.95, 2.2, dt); u.vel.set(0, 0, 0);
    u.yaw = b.yaw; u.bank = 0; u.pitch = 0; u.flying = u.pos.y > g + 2;
    const d = u.pos.distanceTo(player.pos);
    const behind = (player.pos.x - u.pos.x) * player.vel.x + (player.pos.z - u.pos.z) * player.vel.z > 0;
    if (b.t > 30 || (behind && d > 120)) {             // Sperre aufgelöst → schließt sich der Verfolgung an (oder verschwindet)
      u.block = null;
      if (this.units.filter((o) => o.active && !o.block).length >= this.D.count) { u.active = false; u.grp.visible = false; }
    }
  }

  updateHeli(dt, player) {
    const h = this.heli;
    if (!h || !this.heliOn) return;
    const pp = player.pos;
    const back = this._v[2].set(player.vel.x, 0, player.vel.z);
    const sp = back.length(); if (sp > 1) back.multiplyScalar(-1 / sp); else back.set(0, 0, 1);
    const t = this._v[3].copy(this.seen ? pp : this.lastKnown).addScaledVector(player.vel, 1.2).addScaledVector(back, 28);
    let top = this.w.sample(t.x, t.z);
    for (const b of this.w.buildingHash.at(t.x, t.z)) top = Math.max(top, b.top);
    t.y = Math.max(pp.y, top) + 48;
    const dv = this._v[4].subVectors(t, h.pos).multiplyScalar(1.2).sub(h.vel);
    const al = dv.length(), maxA = 16 * dt; if (al > maxA) dv.multiplyScalar(maxA / al);
    h.vel.add(dv);
    h.pos.addScaledVector(h.vel, dt);
    const yawT = Math.atan2(-(pp.x - h.pos.x), -(pp.z - h.pos.z));
    let dy = yawT - h.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); h.yaw += clamp(dy, -dt * 1.2, dt * 1.2);
    h.grp.position.copy(h.pos);
    h.grp.rotation.set(clamp(-h.vel.length() * 0.004, -0.2, 0.2), h.yaw, clamp(-dy * 0.3, -0.25, 0.25), 'YXZ');
    h.rotor.rotation.y += dt * 38; h.tail.rotation.x += dt * 60;
    // Suchscheinwerfer auf den Spieler (bzw. die letzte bekannte Position)
    const aim = this.seen ? pp : this.lastKnown;
    h.spot.target.position.copy(aim);
    h.spot.intensity = this.w.night ? 2200 : 300;
    const from = this._v[5]; h.spot.getWorldPosition(from);
    const len = from.distanceTo(aim) + 2;
    h.beam.position.copy(from); h.beam.lookAt(aim);
    h.beam.scale.set(len * 0.11, len * 0.11, len);
    h.beamMat.opacity = this.w.night ? 0.13 : 0.035;
  }

  updateVisuals(dt, camera) {
    // Blaulicht: Doppelblitz, links/rechts abwechselnd
    // Muster wie bei echten LED-Balken: Doppelblitz links/rechts, Segmente laufen von innen nach außen,
    // alle 4 s ein kurzer „Allblitz“; Grillblitzer gegenläufig
    const t = this.time * 2.2 % 1;
    const a = (t < 0.08 || (t > 0.16 && t < 0.24)) ? 1 : 0, b = (t > 0.5 && t < 0.58) || (t > 0.66 && t < 0.74) ? 1 : 0;
    this.blueA.color.setRGB(0.1 + b * 1.4, 0.2 + b * 2.0, 0.6 + b * 6);
    this.blueB.color.setRGB(0.1 + a * 1.4, 0.2 + a * 2.0, 0.6 + a * 6);
    const all = (this.time % 4) < 0.35 && Math.sin(this.time * 60) > 0;
    if (this.segMats) this.segMats.forEach((m, k) => {
      const left = k < 3, idx = left ? 2 - k : k - 3;                  // 0 = innen
      const sweep = Math.abs(((this.time * 3.3) % 1) * 3 - idx - 0.5) < 0.5;
      const on = all || (left ? a : b) || (sweep && (left ? b : a) === 0 && Math.sin(this.time * 30) > 0.3);
      m.color.setRGB(0.08 + on * 1.4, 0.15 + on * 2.0, 0.5 + on * 6);
    });
    const glowK = Math.max(a, b, all ? 1 : 0);
    const night = this.w.night;
    this.headMat.color.setScalar(night ? 4 : 1.4); this.tailMat.color.setRGB(night ? 3 : 1.2, 0.08, 0.08);
    let anyFly = false;
    const cam = camera.position;
    const list = this.units.filter((u) => u.active).sort((x, y) => x.pos.distanceToSquared(cam) - y.pos.distanceToSquared(cam));
    for (const u of this.units) {
      if (!u.active) continue;
      u.grp.position.set(u.pos.x, u.pos.y - 0.95, u.pos.z);
      u.grp.rotation.set(u.pitch, u.yaw, u.bank, 'YXZ');
      if (u.flying) anyFly = true;
      for (const j of u.jets) j.visible = u.flying;
      { const gy = this.w.sample(u.pos.x, u.pos.z, undefined, u.pos.y), alt = u.pos.y - 0.95 - gy;
        u.glow.visible = alt < 8; u.glow.position.set(u.pos.x, gy + 0.06, u.pos.z); u.glow.material.opacity = glowK * (night ? 0.55 : 0.18) * clamp(1 - alt / 8, 0, 1);
        u.blob.visible = alt < 6; u.blob.position.set(u.pos.x, gy + 0.05, u.pos.z); u.blob.rotation.y = u.yaw; u.blob.material.opacity = 0.6 * clamp(1 - alt / 6, 0, 1); }
    }
    this.jetMat.opacity = anyFly ? 0.55 + Math.sin(this.time * 40) * 0.1 : 0;
    this.flashLights.forEach((l, i) => {
      const u = list[i];
      if (!u) { l.intensity = 0; return; }
      l.position.set(u.pos.x, u.pos.y + 1.4, u.pos.z);
      l.intensity = (i === 0 ? a : b) * (night ? 22 : 8);
    });
  }

  updateHud(hidden) {
    const ui = this.ui;
    const s = '★'.repeat(this.wanted) + '☆'.repeat(5 - this.wanted);
    if (ui.stars.textContent !== s) ui.stars.textContent = s;
    const mm = Math.floor(this.time / 60), ss = Math.floor(this.time % 60);
    const st = this.seen ? `VERFOLGUNG ${mm}:${String(ss).padStart(2, '0')} · +${Math.round(this.rate || 0)} €/s · ${fmtMoney(this.earned || 0)}`
      : `AUSSER SICHT – entkommen in ${Math.max(0, Math.ceil(this.D.escape - hidden))} s`;
    if (ui.status.textContent !== st) ui.status.textContent = st;
    ui.hud.classList.toggle('lost', !this.seen);
    // Festnahme-Timer: Balken läuft hoch, Restzeit in Sekunden; letzte Sekunde rot blinkend
    const B = this.D.bust, on = this.bustT > 0.03;
    ui.bustWrap.classList.toggle('on', on);
    ui.bust.style.width = (clamp(this.bustT / B, 0, 1) * 100).toFixed(1) + '%';
    const rest = Math.max(0, B - this.bustT);
    ui.bustWrap.classList.toggle('last', on && rest < 1);
    const txt = on ? `FESTNAHME ${rest.toFixed(1).replace('.', ',')} s` : '';
    if (ui.bustTxt.textContent !== txt) ui.bustTxt.textContent = txt;
    const lvl = `${s} ${this.D.name.toUpperCase()}`;
    if (ui.stars.textContent !== lvl) ui.stars.textContent = lvl;
  }

  /** Polizei gegen Spieler: schwere Wagen, Impuls nach Masse und Geschwindigkeit. */
  collidePlayer(v) {
    if (!this.active) return;
    const px = v.pos.x, pz = v.pos.z;
    const f = v._v[11].set(0, 0, -1).applyQuaternion(v.quat);
    let pfx = f.x, pfz = f.z; const fl = Math.hypot(pfx, pfz) || 1; pfx /= fl; pfz /= fl;
    const prx = -pfz, prz = pfx, PHX = 0.98, PHZ = 2.28, G = this.geo;
    for (const u of this.units) {
      if (!u.active) continue;
      const dx = u.pos.x - px, dz = u.pos.z - pz;
      if (dx * dx + dz * dz > 49 || Math.abs(u.pos.y - v.pos.y) > 2.2) continue;
      const cfx = -Math.sin(u.yaw), cfz = -Math.cos(u.yaw), crx = -cfz, crz = cfx, CHX = G.W / 2, CHZ = G.L / 2;
      const test = (x, z, ox, oz, ax1x, ax1z, ax2x, ax2z, hx, hz, sgn) => {
        const ax = (x - ox) * ax1x + (z - oz) * ax1z, az = -((x - ox) * ax2x + (z - oz) * ax2z);
        if (Math.abs(ax) >= hx || Math.abs(az) >= hz) return;
        const ddx = hx - Math.abs(ax), ddz = hz - Math.abs(az);
        if (ddx < ddz) { const s2 = Math.sign(ax) * sgn; this.resolve(v, u, x, z, ax1x * s2, ax1z * s2, ddx); }
        else { const s2 = -Math.sign(az) * sgn; this.resolve(v, u, x, z, ax2x * s2, ax2z * s2, ddz); }
      };
      for (const [lx, lz] of [[-PHX, -PHZ], [PHX, -PHZ], [-PHX, PHZ], [PHX, PHZ], [0, -PHZ], [0, PHZ]]) test(px + prx * lx - pfx * lz, pz + prz * lx - pfz * lz, u.pos.x, u.pos.z, crx, crz, cfx, cfz, CHX, CHZ, 1);
      for (const [lx, lz] of [[-CHX, -CHZ], [CHX, -CHZ], [-CHX, CHZ], [CHX, CHZ]]) test(u.pos.x + crx * lx - cfx * lz, u.pos.z + crz * lx - cfz * lz, px, pz, prx, prz, pfx, pfz, PHX, PHZ, -1);
    }
  }

  resolve(v, u, x, z, nx, nz, depth) {
    const m2 = u.mass, wP = m2 / (m2 + v.mass);
    v.pos.x += nx * depth * wP; v.pos.z += nz * depth * wP;
    u.pos.x -= nx * depth * (1 - wP); u.pos.z -= nz * depth * (1 - wP);
    const t = v._v;
    const r1 = t[4].set(x - v.pos.x, -0.1, z - v.pos.z), n = t[5].set(nx, 0, nz);
    const v1 = t[6].crossVectors(v.angVel, r1).add(v.vel);
    const vn = (v1.x - u.vel.x) * nx + (v1.z - u.vel.z) * nz;
    if (vn >= 0) return;
    const rn = t[7].crossVectors(r1, n);
    const k = v.invMass + v.applyInvInertia(t[8].copy(rn)).cross(r1).dot(n) + 1 / m2;
    const j = -(1 + 0.25) * vn / k;
    const J = t[8].copy(n).multiplyScalar(j);
    v.vel.addScaledVector(J, v.invMass);
    v.angVel.add(v.applyInvInertia(t[9].crossVectors(r1, J)));
    u.vel.x -= nx * j / m2; u.vel.z -= nz * j / m2;
    if (-vn > 4) {
      v.lastImpact = Math.max(v.lastImpact, -vn);
      const now = this.time;
      if (!(u.lastRam > now - 1)) { u.lastRam = now; this.rams++; }
      if (this.w.fx.length < 30) this.w.fx.push({ type: 'spark', x, y: v.pos.y - 0.1, z, s: -vn, nx, nz });
    }
  }
}

export { SaveData, fmtMoney, POLICE_LEVELS, makePoliceGeometry, makePoliceDecal, PoliceSystem };
