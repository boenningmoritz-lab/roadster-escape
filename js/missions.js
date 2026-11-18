import * as THREE from 'three';
import { CONFIG, clamp, lerp, Settings } from './config.js';
import { Haptics, Input } from './input.js';
import { WORLD } from './world/world.js';
import { CarModel } from './vehicle/carmodel.js';
import { SaveData, fmtMoney } from './police.js';
import { game } from './main.js';

// ============================== Missionen ==============================
/**
 * 14 Missionen in 8 Arten: Checkpoint-Rennen, Flug-Parcours, Polizei-Flucht,
 * Bäume-Zerstörer, Drift-Punkte, Lieferung ohne Polizeikontakt, Weitsprung,
 * Rennen gegen KI-Gegner – teils nachts. Bronze/Silber/Gold, Geld als Belohnung,
 * werden nach und nach freigeschaltet.
 */
const MISSIONS = [
  { id: 'cityloop',  name: 'Stadtrunde',        type: 'race',    desc: 'Fahre die Checkpoints rund um die Innenstadt ab.', route: [[300, 150], [1000, 150], [1000, 850], [300, 850], [300, 250]], speeds: [30, 25, 19], reward: 1200 },
  { id: 'firstfly',  name: 'Erster Flug',       type: 'rings',   desc: 'Hebe ab und fliege durch alle Ringe über dem See.', start: [-300, 950], rings: 'lake', speeds: [34, 27, 20], reward: 1500 },
  { id: 'lumber',    name: 'Holzfäller',        type: 'trees',   desc: 'Fälle in 60 Sekunden so viele Bäume wie möglich.', start: [-560, -290], time: 60, goals: [32, 20, 10], reward: 1400 },
  { id: 'drift',     name: 'Drift-König',       type: 'drift',   desc: 'Sammle Drift-Punkte auf dem Flugplatz. Fahrhilfen aus!', start: [300, -1000], time: 60, goals: [26000, 15000, 7000], reward: 1600 },
  { id: 'longjump',  name: 'Weitsprung',        type: 'jump',    desc: 'Nutze die Rampen am Flugplatz: Der weiteste Sprung zählt.', start: [-450, -1000], time: 90, goals: [110, 75, 45], reward: 1600 },
  { id: 'breakout',  name: 'Ausbruch',          type: 'escape',  desc: 'Entkomme der Polizei (Normal).', start: [650, 450], police: 'normal', goals: [40, 70, 999], reward: 2000 },
  { id: 'delivery',  name: 'Eilige Lieferung',  type: 'delivery', desc: 'Bring das Paket zum Flugplatz – ohne Polizeikontakt.', start: [650, 452], dest: [520, -1060], police: 'hard', speeds: [30, 24, 17], reward: 2600 },
  { id: 'hwduel',    name: 'Autobahn-Duell',    type: 'raceai',  desc: 'Schlage zwei KI-Gegner auf der Autobahn.', route: [[1440, 420], [1420, 1050], [850, 1400], [0, 1350]], opponents: 2, reward: 3000 },
  { id: 'nightrun',  name: 'Nachtfahrt',        type: 'race',    desc: 'Nachts über die Landstraße zum Autobahnring.', route: [[500, 150], [320, -700], [-100, -940], [-500, -1330]], night: true, speeds: [36, 30, 23], reward: 2600 },
  { id: 'forestfly', name: 'Waldschneise',      type: 'rings',   desc: 'Tief und schnell: Ringe knapp über der Waldstraße.', start: [-50, 600], rings: 'forest', speeds: [36, 29, 22], reward: 2800 },
  { id: 'manhunt',   name: 'Großfahndung',      type: 'escape',  desc: 'Nachts, 6 Wagen und ein Hubschrauber. Entkomme!', start: [650, 450], police: 'extreme', night: true, goals: [60, 100, 999], reward: 4500 },
  { id: 'courier',   name: 'Nachtkurier',       type: 'delivery', desc: 'Lieferung vom Flugplatz zum See – die Polizei ist hellwach.', start: [300, -950], dest: [-300, 1000], police: 'extreme', night: true, speeds: [32, 25, 18], reward: 5000 },
  { id: 'bridge',    name: 'Brückenrennen',     type: 'raceai',  desc: 'Nachtrennen über die Seebrücke gegen drei Gegner.', route: [[-480, 1205], [-700, 1150], [-640, 650], [-850, 100], [-1390, -450]], opponents: 3, night: true, reward: 5500 },
  { id: 'insane',    name: 'Staatsfeind Nr. 1', type: 'escape',  desc: 'Zehn Wagen, Hubschrauber, Straßensperren. Viel Glück.', start: [650, 450], police: 'insane', goals: [70, 120, 999], reward: 9000 },
];
const MEDALS = ['', 'Bronze', 'Silber', 'Gold'];
const MEDAL_ICON = ['', '🥉', '🥈', '🥇'];

class MissionSystem {
  constructor(game) {
    this.g = game; this.w = game.world; this.scene = game.scene;
    this.active = null;
    SaveData.data.missions = SaveData.data.missions || {};
    // Markierungen (Lichtsäulen) an den Startpunkten
    this.markerMat = new THREE.MeshBasicMaterial({ color: 0xffc13b, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.markers = MISSIONS.map((m) => {
      const p = this.startPose(m);
      const grp = new THREE.Group();
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 60, 24, 1, true).translate(0, 30, 0), this.markerMat);
      const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 4.2, 40).rotateX(-Math.PI / 2), this.markerMat);
      ring.position.y = 0.2;
      grp.add(pillar, ring);
      grp.position.set(p.x, this.w.sample(p.x, p.z), p.z);
      this.scene.add(grp);
      return { grp, m, p };
    });
    this.gateMat = new THREE.MeshBasicMaterial({ color: 0x36e0ff, toneMapped: false });
    this.gateDim = new THREE.MeshBasicMaterial({ color: 0x1a5a70, transparent: true, opacity: 0.5, toneMapped: false });
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffa22b, toneMapped: false });
    this.destMat = new THREE.MeshBasicMaterial({ color: 0x5dff9a, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.objects = [];
    // Richtungspfeil über dem Auto
    this.arrow = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.4, 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x36e0ff, toneMapped: false }));
    this.arrow.visible = false; this.scene.add(this.arrow);
    this.ui = {
      box: document.getElementById('mHud'), title: document.getElementById('mTitle'), info: document.getElementById('mInfo'),
      big: document.getElementById('mBig'), prompt: document.getElementById('mPrompt'),
    };
    this.promptFor = null;
    this.ui.prompt.addEventListener('pointerdown', (e) => { e.preventDefault(); if (this.promptFor) this.start(this.promptFor); });
    document.getElementById('mAbort').addEventListener('pointerdown', (e) => { e.preventDefault(); this.finish(false, 'Abgebrochen'); });
    this.refreshMarkers();
  }

  isUnlocked(i) {
    const done = MISSIONS.filter((m) => (SaveData.data.missions[m.id]?.medal || 0) > 0).length;
    return i < 3 + done;
  }

  startPose(m) {
    const s = m.start || m.route[0];
    const yaw = m.route ? Math.atan2(-(m.route[1][0] - m.route[0][0]), -(m.route[1][1] - m.route[0][1])) : 0;
    return this.w.nearestRoadPose(s[0], s[1], yaw);
  }

  refreshMarkers() {
    this.markers.forEach((mk, i) => { mk.grp.visible = !this.active && this.isUnlocked(i); });
  }

  // ------------------------------------------------------------ Routen
  nearestNode(x, z) {
    let best = null, bd = 1e18;
    for (const n of this.w.nodes) { const d = (n.x - x) ** 2 + (n.z - z) ** 2; if (d < bd) { bd = d; best = n; } }
    return best;
  }
  /** Kürzester Weg im Straßengraphen (Dijkstra) als Punktfolge. */
  path(a, b) {
    const dist = new Map([[a, 0]]), prev = new Map(), open = new Set([a]);
    while (open.size) {
      let u = null, ud = Infinity;
      for (const n of open) { const d = dist.get(n); if (d < ud) { ud = d; u = n; } }
      open.delete(u);
      if (u === b) break;
      for (const e of u.edges) {
        const o = e.a === u ? e.b : e.a, nd = ud + e.len;
        if (nd < (dist.get(o) ?? Infinity)) { dist.set(o, nd); prev.set(o, { from: u, e }); open.add(o); }
      }
    }
    const segs = [];
    for (let n = b; n !== a;) { const p = prev.get(n); if (!p) break; segs.unshift({ e: p.e, fwd: p.e.a === p.from }); n = p.from; }
    const pts = [];
    for (const { e, fwd } of segs) {
      const list = fwd ? e.pts : [...e.pts].reverse();
      for (const p of list) { const last = pts[pts.length - 1]; if (!last || Math.hypot(last.x - p.x, last.z - p.z) > 1) pts.push({ x: p.x, y: p.y, z: p.z }); }
    }
    return pts;
  }
  buildRoute(wps) {
    let pts = [];
    for (let i = 0; i < wps.length - 1; i++) {
      const seg = this.path(this.nearestNode(...wps[i]), this.nearestNode(...wps[i + 1]));
      pts = pts.concat(i ? seg.slice(1) : seg);
    }
    // Länge aufsummieren
    let s = 0; pts.forEach((p, i) => { if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z); p.s = s; });
    return pts;
  }
  pointAt(route, s) {
    s = clamp(s, 0, route[route.length - 1].s);
    let lo = 0, hi = route.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (route[mid].s < s) lo = mid; else hi = mid; }
    const a = route[lo], b = route[hi], t = (s - a.s) / Math.max(b.s - a.s, 1e-6);
    const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1;
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t), tx: tx / tl, tz: tz / tl };
  }

  // ------------------------------------------------------------ Start/Ende
  start(m) {
    if (this.active) this.finish(false, null, true);
    const g = this.g, v = g.vehicle;
    if (g.police.active) g.police.stop(false);
    document.getElementById('missions').hidden = true;
    g.paused = false;
    const A = this.active = { m, t: 0, phase: 'count', count: 3, score: 0, objs: [], data: {} };
    this.prevTime = Settings.data.timeOfDay;
    if (m.night && g.timeOfDay !== 'night') g.setTimeOfDay('night');
    if (!m.night && g.timeOfDay !== 'day') g.setTimeOfDay('day');
    const pose = this.startPose(m);
    g.spawnAt(pose.x, pose.z, pose.yaw);
    A.lockPos = v.pos.clone(); A.lockQuat = v.quat.clone();
    v.boostEnergy = 1; v.flyEnergy = 1;
    if (m.type === 'drift') { A.prevTC = v.tractionControl; v.tractionControl = false; }
    if (m.type === 'race' || m.type === 'raceai') {
      A.route = this.buildRoute(m.route);
      const L = A.route[A.route.length - 1].s;
      A.cps = [];
      const n = Math.max(4, Math.round(L / 260));
      for (let k = 1; k <= n; k++) A.cps.push(this.pointAt(A.route, (L * k) / n));
      A.cps.forEach((c, i) => this.addGate(A, c, i === A.cps.length - 1));
      if (m.speeds) A.goals = m.speeds.map((sp) => L / sp);
      A.cp = 0; A.len = L;
      if (m.type === 'raceai') this.makeOpponents(A, m.opponents);
    }
    if (m.type === 'rings') {
      A.rings = this.ringLayout(m.rings);
      A.rings.forEach((r) => this.addRing(A, r));
      let L = 0; A.rings.forEach((r, i) => { if (i) L += Math.hypot(r.x - A.rings[i - 1].x, r.y - A.rings[i - 1].y, r.z - A.rings[i - 1].z); });
      A.goals = m.speeds.map((sp) => (L + 150) / sp);
      A.cp = 0;
    }
    if (m.type === 'delivery') {
      const d = this.w.nearestRoadPose(m.dest[0], m.dest[1], 0);
      A.dest = new THREE.Vector3(d.x, this.w.sample(d.x, d.z), d.z);
      const pil = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 80, 24, 1, true).translate(0, 40, 0), this.destMat);
      pil.position.copy(A.dest); this.scene.add(pil); A.objs.push(pil);
      const L = Math.hypot(A.dest.x - pose.x, A.dest.z - pose.z) * 1.35;
      A.goals = m.speeds.map((sp) => L / sp);
    }
    if (m.type === 'trees') A.felled = 0;
    if (m.type === 'drift') { A.combo = 1; A.chain = 0; A.drifting = 0; }
    if (m.type === 'jump') { A.best = 0; A.cur = null; }
    this.refreshMarkers();
    this.ui.box.hidden = false;
    this.ui.title.textContent = m.name;
    this.big('3');
    Haptics.pulse(20);
  }

  addGate(A, c, last) {
    const grp = new THREE.Group();
    const torus = new THREE.Mesh(new THREE.TorusGeometry(8.5, 0.32, 8, 40), this.gateDim);
    torus.position.y = 4.5; grp.add(torus);
    for (const s of [-1, 1]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 4.5, 8).translate(0, 2.25, 0), this.gateDim); post.position.x = s * 8.5; grp.add(post); }
    if (last) { const flag = new THREE.Mesh(new THREE.PlaneGeometry(17, 1.6), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false })); flag.position.y = 13.4; grp.add(flag); }
    grp.position.set(c.x, c.y, c.z);
    grp.rotation.y = Math.atan2(c.tx, c.tz);
    this.scene.add(grp); A.objs.push(grp);
    c.mesh = torus; c.grp = grp;
  }

  addRing(A, r) {
    const torus = new THREE.Mesh(new THREE.TorusGeometry(7, 0.45, 10, 44), this.ringMat);
    torus.position.set(r.x, r.y, r.z); torus.rotation.y = r.yaw;
    this.scene.add(torus); A.objs.push(torus); r.mesh = torus;
  }

  ringLayout(kind) {
    const w = this.w, out = [];
    if (kind === 'lake') {
      const L = WORLD.lake;
      for (let k = 0; k < 9; k++) {
        const a = -0.6 + k * 0.62, r = 230 + Math.sin(k * 1.7) * 40;
        const x = L.cx + Math.cos(a) * r, z = L.cz + Math.sin(a) * r;
        out.push({ x, z, y: Math.max(w.sample(x, z), w.waterLevel) + 14 + (k % 3) * 9 });
      }
    } else {
      const e = w.edges.find((ed) => ed.cls === 'country' && ed.a.type === 'junction' && ed.b.type === 'hwj' && ed.len > 1200) || w.edges.find((ed) => ed.cls === 'country');
      for (let k = 1; k <= 10; k++) {
        const p = w.pointOnEdge(e, e.len * k / 11);
        out.push({ x: p.x, z: p.z, y: p.y + 7 + (k % 2) * 3 });
      }
    }
    out.forEach((r, i) => {
      const n = out[Math.min(i + 1, out.length - 1)], pr = out[Math.max(i - 1, 0)];
      r.yaw = Math.atan2(n.x - pr.x, n.z - pr.z);
    });
    return out;
  }

  makeOpponents(A, n) {
    const paints = ['#d01818', '#1b2c8a', '#151515'];
    A.opps = [];
    const q = { ...this.g.q, headlights: false, physicalPaint: false, bevelSegs: 1 };
    for (let i = 0; i < n; i++) {
      const model = new CarModel(CONFIG.car, q);
      model.paint.color.set(paints[i % paints.length]);
      for (const l of model.headLights) l.parent.remove(l);
      this.scene.add(model.root);
      A.objs.push(model.root);
      A.opps.push({ model, s: 0, speed: 0, lane: (i % 2 ? -1 : 1) * 2.2, vmax: 66 - i * 3, done: false, pos: new THREE.Vector3(), yaw: 0, mass: 1650, vel: new THREE.Vector3() });
    }
  }

  finish(success, msg, silent) {
    const A = this.active;
    if (!A) return;
    const g = this.g, m = A.m;
    for (const o of A.objs) this.scene.remove(o);
    this.arrow.visible = false;
    if (g.police.active) g.police.stop(false);
    document.getElementById('btnPolice').classList.remove('on');
    if (A.prevTC !== undefined) g.vehicle.tractionControl = A.prevTC;
    this.active = null;
    this.ui.box.hidden = true; this.ui.big.hidden = true;
    if ((m.night ? 'night' : 'day') !== this.prevTime) g.setTimeOfDay(this.prevTime);
    this.refreshMarkers();
    if (silent) return;
    // Medaille bestimmen
    let medal = 0;
    if (success) {
      const goals = A.goals || m.goals;
      const lowerBetter = ['race', 'rings', 'delivery', 'escape'].includes(m.type);
      if (m.type === 'raceai') medal = 4 - A.place;
      else for (let k = 0; k < 3; k++) if (lowerBetter ? A.score <= goals[k] : A.score >= goals[k]) { medal = 3 - k; break; }
      if (!lowerBetter && m.type !== 'raceai' && A.score > 0 && medal === 0) medal = 0;
    }
    const rec = SaveData.data.missions[m.id] || { medal: 0, best: null };
    const factors = [0, 0.4, 0.7, 1];
    const reward = Math.max(0, Math.round(m.reward * (factors[medal] - factors[rec.medal])));
    if (medal > rec.medal) rec.medal = medal;
    rec.best = A.score;
    SaveData.data.missions[m.id] = rec;
    if (reward) SaveData.addMoney(reward); else SaveData.save();
    const scoreTxt = this.scoreText(A);
    document.getElementById('resTitle').textContent = medal ? `${MEDAL_ICON[medal]} ${MEDALS[medal].toUpperCase()}` : (success ? 'GESCHAFFT' : 'NICHT GESCHAFFT');
    document.getElementById('resTitle').style.color = medal === 3 ? '#ffd23f' : medal === 2 ? '#d8dde3' : medal === 1 ? '#e0a060' : '#ff6b7a';
    document.getElementById('resText').textContent = `${m.name} · ${msg || scoreTxt}`;
    document.getElementById('resMoney').textContent = reward ? '+ ' + fmtMoney(reward) : (medal ? 'keine neue Medaille' : 'kein Geld');
    document.getElementById('result').hidden = false;
    g.paused = true; Input.releaseAll();
    Haptics.pulse(medal ? 45 : 80);
  }

  scoreText(A) {
    const m = A.m, t = A.score;
    const time = (x) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`;
    switch (m.type) {
      case 'race': case 'rings': case 'delivery': return 'Zeit ' + time(t);
      case 'escape': return 'entkommen nach ' + time(t);
      case 'trees': return `${t} Bäume`;
      case 'drift': return `${Math.round(t).toLocaleString('de-DE')} Punkte`;
      case 'jump': return `weitester Sprung ${t.toFixed(1)} m`;
      case 'raceai': return `Platz ${A.place}`;
    }
    return '';
  }

  big(text, ms = 900) {
    const b = this.ui.big; b.textContent = text; b.hidden = false;
    clearTimeout(this._bt); this._bt = setTimeout(() => { b.hidden = true; }, ms);
  }

  // ------------------------------------------------------------ Laufzeit
  update(dt) {
    const g = this.g, v = g.vehicle;
    // Startpunkt-Hinweis in der freien Fahrt
    if (!this.active) {
      let near = null;
      // Teleport (Spawn/Reset) → Ringe, in denen man steht, erst nach dem Verlassen wieder anbieten
      if (this._lp && Math.hypot(this._lp.x - v.pos.x, this._lp.z - v.pos.z) > 30) this.markers.forEach((mk) => { mk.wasOut = false; });
      this._lp = { x: v.pos.x, z: v.pos.z };
      this.markers.forEach((mk) => {
        const d = Math.hypot(mk.p.x - v.pos.x, mk.p.z - v.pos.z);
        if (d > 17) mk.wasOut = true;
        // nur anbieten, wenn man langsam (< 30 km/h) in den Ring hineinfährt
        if (mk.grp.visible && mk.wasOut && d < 14 && v.speed < 8.5) near = mk.m;
      });
      if (near !== this.promptFor) {
        this.promptFor = near;
        this.ui.prompt.hidden = !near;
        if (near) this.ui.prompt.innerHTML = `<b>${near.name}</b><small>${near.desc}</small><span>STARTEN</span>`;
      }
      const cam = g.camera.position;
      for (const mk of this.markers) {
        mk.grp.children[1].rotation.y += dt;
        mk.grp.children[0].visible = Math.hypot(cam.x - mk.p.x, cam.z - mk.p.z) > 30;   // Lichtsäule nur aus der Ferne (sonst füllt sie das Bild)
      }
      this.markerMat.opacity = 0.28 + Math.sin(performance.now() / 300) * 0.08;
      return;
    }
    this.ui.prompt.hidden = true; this.promptFor = null;
    const A = this.active, m = A.m;
    // Countdown: Auto steht fest
    if (A.phase === 'count') {
      A.t += dt;
      v.pos.copy(A.lockPos); v.quat.copy(A.lockQuat); v.vel.set(0, 0, 0); v.angVel.set(0, 0, 0);
      const c = 3 - Math.floor(A.t);
      if (c !== A.count && c > 0) { A.count = c; this.big(String(c)); Haptics.pulse(12); }
      if (A.t >= 3) {
        A.phase = 'run'; A.t = 0; this.big('LOS!', 700); Haptics.pulse(30);
        if (m.police) { g.police.start(m.police, v, g.camera); document.getElementById('btnPolice').classList.add('on'); }
        if (m.type === 'rings' && !v.flying) v.toggleFly();
      }
      this.updateHud(A);
      return;
    }
    A.t += dt;
    if (m.type !== 'rings' && m.type !== 'jump' && m.type !== 'escape' && m.type !== 'trees' && m.type !== 'drift' && v.flying) v.landing = true;   // Rennen: kein Abkürzen durch die Luft
    switch (m.type) {
      case 'race': case 'raceai': this.updateRace(A, dt); break;
      case 'rings': this.updateRings(A, dt); break;
      case 'trees': if (A.t >= m.time) { A.score = A.felled; this.finish(true); } break;
      case 'drift': this.updateDrift(A, dt); break;
      case 'jump': this.updateJump(A, dt); break;
      case 'delivery': this.updateDelivery(A, dt); break;
      case 'escape': this.updateEscape(A, dt); break;
    }
    if (this.active) this.updateHud(A);
  }

  /** Weltereignisse, die Missionen zählen (vor dem Leeren der Ereignisliste). */
  onWorldEvent(e) {
    const A = this.active;
    if (!A || A.phase !== 'run') return;
    if (e.type === 'tree' && A.m.type === 'trees') { A.felled++; this.big('+1', 400); }
  }

  /** Polizei hat ein Ergebnis gemeldet (bei Flucht-/Liefermissionen). */
  onPoliceResult(r) {
    const A = this.active;
    if (!A) return false;
    if (A.m.type === 'escape') { if (r.result === 'escaped') { A.score = A.t; this.finish(true); } else this.finish(false, 'Erwischt'); return true; }
    if (A.m.type === 'delivery') { if (r.result === 'busted') { this.finish(false, 'Erwischt'); return true; } g_restartPolice(this.g, A.m.police); return true; }
    return false;
  }

  updateRace(A, dt) {
    const v = this.g.vehicle, cp = A.cps[A.cp];
    const d = Math.hypot(v.pos.x - cp.x, v.pos.z - cp.z);
    if (d < 11) {
      A.cp++;
      Haptics.pulse(15);
      if (A.cp >= A.cps.length) {
        A.score = A.t;
        if (A.m.type === 'raceai') A.place = 1 + A.opps.filter((o) => o.done && o.time < A.t).length;
        this.finish(true); return;
      }
      this.big(`${A.cp}/${A.cps.length}`, 500);
    }
    A.cps.forEach((c, i) => { c.mesh.material = i === A.cp ? this.gateMat : this.gateDim; c.grp.visible = i >= A.cp && i < A.cp + 3; });
    this.pointArrow(A.cps[A.cp]);
    if (A.opps) this.updateOpponents(A, dt);
  }

  updateOpponents(A, dt) {
    const v = this.g.vehicle, R = A.route, L = A.len;
    // Fortschritt des Spielers ≈ Bogenlänge des nächsten Routenpunkts
    let ps = 0, bd = 1e18;
    for (let i = 0; i < R.length; i += 3) { const d = (R[i].x - v.pos.x) ** 2 + (R[i].z - v.pos.z) ** 2; if (d < bd) { bd = d; ps = R[i].s; } }
    A.playerS = ps;
    for (const o of A.opps) {
      if (o.done) continue;
      const here = this.pointAt(R, o.s), ahead = this.pointAt(R, o.s + 45);
      const ang = Math.acos(clamp(here.tx * ahead.tx + here.tz * ahead.tz, -1, 1));
      let vt = ang > 0.04 ? Math.min(o.vmax, Math.sqrt(10 * 45 / ang)) : o.vmax;
      const gap = o.s - ps;                                 // Gummiband: dranbleiben, nicht davonziehen
      vt *= gap > 150 ? 0.86 : gap < -120 ? 1.12 : 1;
      o.speed += clamp(vt - o.speed, -11 * dt, 7.5 * dt);
      o.s += o.speed * dt;
      const p = this.pointAt(R, o.s);
      const rx = -p.tz, rz = p.tx;
      o.pos.set(p.x + rx * o.lane, p.y, p.z + rz * o.lane);
      o.vel.set(p.tx * o.speed, 0, p.tz * o.speed);
      const yawT = Math.atan2(-p.tx, -p.tz);
      let dy = yawT - o.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); o.yaw += dy * Math.min(1, dt * 8);
      o.model.root.position.set(o.pos.x, o.pos.y + 0.45, o.pos.z);
      o.model.root.rotation.set(0, o.yaw, 0);
      if (o.s >= L) { o.done = true; o.time = A.t; }
    }
    // Platzierung
    const ahead = A.opps.filter((o) => o.s > ps).length;
    A.place = 1 + ahead;
  }

  updateRings(A, dt) {
    const v = this.g.vehicle, r = A.rings[A.cp];
    if (!v.flying && v.flyEnergy > 0.15 && A.t > 1) v.toggleFly();
    const d = Math.hypot(v.pos.x - r.x, v.pos.y - r.y, v.pos.z - r.z);
    if (d < 7.2) {
      A.cp++; Haptics.pulse(15); this.big(`${A.cp}/${A.rings.length}`, 500);
      r.mesh.visible = false;
      if (A.cp >= A.rings.length) { A.score = A.t; this.finish(true); return; }
    }
    A.rings.forEach((x, i) => { x.mesh.material.color?.setHex?.(0xffa22b); x.mesh.scale.setScalar(i === A.cp ? 1 + Math.sin(A.t * 6) * 0.05 : 0.9); });
    this.pointArrow(A.rings[A.cp]);
    if (A.t > A.goals[2] * 2.5) this.finish(false, 'Zeit abgelaufen');
  }

  updateDrift(A, dt) {
    const v = this.g.vehicle, m = A.m;
    const f = this._f || (this._f = new THREE.Vector3());
    f.set(0, 0, -1).applyQuaternion(v.quat);
    const fwd = v.vel.x * f.x + v.vel.z * f.z, lat = v.vel.x * -f.z + v.vel.z * f.x;
    const beta = Math.abs(Math.atan2(lat, Math.max(Math.abs(fwd), 1)));
    if (v.groundedCount >= 3 && v.speed > 8 && beta > 0.22 && beta < 1.6) {
      A.drifting = 0; A.chain += v.speed * beta * dt * 16 * A.combo;
      A.combo = Math.min(5, A.combo + dt * 0.35);
    } else if ((A.drifting += dt) > 1.0 && A.chain > 0) {
      A.score += A.chain; this.big('+' + Math.round(A.chain), 600); A.chain = 0; A.combo = 1;
    }
    if (v.lastImpact > 3) { A.chain = 0; A.combo = 1; }
    if (A.t >= m.time) { A.score += A.chain; this.finish(true); }
  }

  updateJump(A, dt) {
    const v = this.g.vehicle;
    if (v.groundedCount === 0 && !v.flying) {
      if (!A.cur) A.cur = { x: v.pos.x, z: v.pos.z, t: 0 };
      A.cur.t += dt;
    } else if (A.cur) {
      if (A.cur.t > 0.5) {
        const dist = Math.hypot(v.pos.x - A.cur.x, v.pos.z - A.cur.z);
        if (dist > A.best) { A.best = dist; this.big(`${dist.toFixed(1)} m`, 1200); }
        A.score = A.best;
      }
      A.cur = null;
    }
    if (A.t >= A.m.time) this.finish(true);
  }

  updateDelivery(A, dt) {
    const v = this.g.vehicle, P = this.g.police;
    this.pointArrow(A.dest);
    if (P.rams > (A.rams || 0)) { this.finish(false, 'Polizeikontakt – Lieferung verloren'); return; }
    if (Math.hypot(v.pos.x - A.dest.x, v.pos.z - A.dest.z) < 7 && v.speed < 12) { A.score = A.t; this.finish(true); }
  }

  updateEscape(A) { /* Ergebnis kommt über onPoliceResult */ void A; }

  pointArrow(t) {
    const v = this.g.vehicle, a = this.arrow;
    a.visible = true;
    a.position.set(v.pos.x, v.pos.y + 2.4, v.pos.z);
    a.lookAt(t.x, v.pos.y + 2.4 + clamp((t.y ?? v.pos.y) - v.pos.y, -15, 15) * 0.2, t.z);
  }

  updateHud(A) {
    const m = A.m, t = A.t;
    const time = (x) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`;
    const goals = A.goals || m.goals;
    let txt = '';
    switch (m.type) {
      case 'race': txt = `Checkpoint ${A.cp}/${A.cps.length} · ${time(t)} · 🥇 ${time(goals[0])}`; break;
      case 'raceai': txt = `Platz ${A.place || 1}/${A.opps.length + 1} · Checkpoint ${A.cp}/${A.cps.length} · ${time(t)}`; break;
      case 'rings': txt = `Ring ${A.cp}/${A.rings.length} · ${time(t)} · 🥇 ${time(goals[0])}`; break;
      case 'trees': txt = `Bäume ${A.felled} · noch ${Math.max(0, m.time - t).toFixed(0)} s · 🥇 ${goals[0]}`; break;
      case 'drift': txt = `${Math.round(A.score).toLocaleString('de-DE')} Punkte${A.chain > 0 ? ` + ${Math.round(A.chain)} ×${A.combo.toFixed(1)}` : ''} · noch ${Math.max(0, m.time - t).toFixed(0)} s`; break;
      case 'jump': txt = `Bester Sprung ${A.best.toFixed(1)} m · noch ${Math.max(0, m.time - t).toFixed(0)} s · 🥇 ${goals[0]} m`; break;
      case 'delivery': { const d = Math.hypot(this.g.vehicle.pos.x - A.dest.x, this.g.vehicle.pos.z - A.dest.z); txt = `Ziel ${Math.round(d)} m · ${time(t)} · keine Polizeiberührung!`; break; }
      case 'escape': txt = `Entkomme der Polizei · ${time(t)} · 🥇 unter ${time(goals[0])}`; break;
    }
    if (A.phase === 'count') txt = m.desc;
    if (this.ui.info.textContent !== txt) this.ui.info.textContent = txt;
  }

  /** Missionsliste (🏁). */
  openList() {
    const list = document.getElementById('mList');
    list.innerHTML = '';
    MISSIONS.forEach((m, i) => {
      const rec = SaveData.data.missions[m.id] || { medal: 0 };
      const ok = this.isUnlocked(i);
      const el = document.createElement('button');
      el.className = 'mItem' + (ok ? '' : ' locked');
      el.innerHTML = `<span class="mMedal">${ok ? (MEDAL_ICON[rec.medal] || '◯') : '🔒'}</span><span class="mText"><b>${m.name}${m.night ? ' 🌙' : ''}</b><small>${ok ? m.desc : 'Schalte frühere Missionen frei'}</small></span><span class="mReward">${fmtMoney(m.reward)}</span>`;
      if (ok) el.addEventListener('click', () => this.start(m));
      list.appendChild(el);
    });
    document.getElementById('missions').hidden = false;
    this.g.paused = true; Input.releaseAll();
  }
}

/** Liefermission: Polizei bleibt dran, auch wenn sie den Spieler kurz verliert. */
function g_restartPolice(game, level) {
  game.police.start(level, game.vehicle, game.camera);
  document.getElementById('btnPolice').classList.add('on');
}

export { MISSIONS, MEDALS, MEDAL_ICON, MissionSystem, g_restartPolice };
