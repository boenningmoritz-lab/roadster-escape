import * as THREE from 'three';
import { CONFIG, clamp } from './config.js';
import { Haptics, Input, View, toast } from './input.js';
import { radialTexture } from './world/world.js';
import { Vehicle } from './vehicle/vehicle.js';
import { CarModel } from './vehicle/carmodel.js';
import { SaveData, fmtMoney } from './police.js';
import { game } from './main.js';

// ============================== Upgrades & Aussehen ==============================
const BASE_CAR = JSON.parse(JSON.stringify(CONFIG.car));
const UPGRADES = [
  { key: 'motor',      name: 'Motor / Leistung',      desc: '+9 % Leistung je Stufe',                 prices: [3000, 6000, 11000, 19000, 32000] },
  { key: 'topspeed',   name: 'Höchstgeschwindigkeit', desc: 'weniger Luftwiderstand, höhere Drehzahl', prices: [2500, 5000, 9000, 16000, 27000] },
  { key: 'accel',      name: 'Beschleunigung',        desc: 'mehr Drehmoment, leichtere Bauteile',     prices: [2500, 5000, 9000, 16000, 27000] },
  { key: 'grip',       name: 'Grip / Handling',       desc: 'weichere Reifenmischung, straffere Stabis', prices: [2000, 4000, 7500, 13000, 22000] },
  { key: 'brakes',     name: 'Bremsen',               desc: 'Keramikbremsen, +12 % Bremskraft',        prices: [1500, 3000, 6000, 10000, 17000] },
  { key: 'boostPower', name: 'Boost-Stärke',          desc: '+15 % Schub',                             prices: [2000, 4000, 8000, 14000, 24000] },
  { key: 'boostTime',  name: 'Boost-Dauer',           desc: 'hält länger, lädt schneller',             prices: [2000, 4000, 8000, 14000, 24000] },
  { key: 'flyTime',    name: 'Flugzeit',              desc: 'größerer Energiespeicher',                prices: [2500, 5000, 9000, 16000, 27000] },
  { key: 'flyCtrl',    name: 'Flugsteuerung',         desc: 'stärkere Düsen, wendiger in der Luft',    prices: [2500, 5000, 9000, 16000, 27000] },
];
const LOOK_DEFAULT = { model: 'roadster', paint: '#f2f2ee', finish: 'glossy', rims: 'sport5', rimColor: '#c8ccd2', underglow: 'off', spoiler: 'none',
  seat: '#2a2a2e', wheel: 'round', ambient: '#36e0ff', display: 'cyan' };
const COSMETIC_PRICES = { 'model:limo': 6000, 'model:kombi': 5000, 'model:suv': 7000, 'finish:metallic': 800, 'finish:matt': 800, 'rims:multi': 1500, 'rims:turbine': 1800, 'rims:mesh': 1500,
  'spoiler:lip': 1200, 'spoiler:wing': 3500, 'underglow': 2500, 'wheel:yoke': 600, 'wheel:sport': 600 };
const DISPLAY_THEMES = { cyan: ['#36e0ff', '#04111a'], amber: ['#ffb02e', '#140c02'], violet: ['#b07cff', '#0d0618'], green: ['#4dff9a', '#03140a'] };
SaveData.data.upgrades = SaveData.data.upgrades || {};
SaveData.data.look = Object.assign({}, LOOK_DEFAULT, SaveData.data.look || {});
SaveData.data.owned = SaveData.data.owned || [];

/** Fahrzeug-Konfiguration aus Grundwerten + gekauften Upgrades + Spoiler. */
function buildCarConfig() {
  const c = JSON.parse(JSON.stringify(BASE_CAR)), u = SaveData.data.upgrades, L = SaveData.data.look;
  const l = (k) => u[k] || 0;
  c.motor.maxPower *= 1 + 0.09 * l('motor'); c.motor.maxTorque *= 1 + 0.04 * l('motor');
  c.aero.CdA *= 1 - 0.05 * l('topspeed'); c.motor.redline += 600 * l('topspeed');
  c.motor.maxTorque *= 1 + 0.08 * l('accel'); c.mass *= 1 - 0.02 * l('accel');
  c.tire.mu *= 1 + 0.04 * l('grip'); c.suspension.antiRollFront *= 1 + 0.06 * l('grip'); c.suspension.antiRollRear *= 1 + 0.06 * l('grip');
  c.brake.maxForce *= 1 + 0.12 * l('brakes');
  c.boost.force *= 1 + 0.15 * l('boostPower');
  c.boost.drain *= 1 - 0.13 * l('boostTime'); c.boost.recharge *= 1 + 0.1 * l('boostTime');
  c.flight.drain *= 1 - 0.14 * l('flyTime'); c.flight.recharge *= 1 + 0.1 * l('flyTime');
  const fc = 1 + 0.12 * l('flyCtrl'); c.flight.yawRate *= fc; c.flight.climb *= fc; c.flight.thrust *= fc;
  // Spoiler: echter Abtrieb, etwas mehr Luftwiderstand
  if (L.spoiler === 'wing') { c.aero.ClA += 0.3; c.aero.CdA += 0.03; } else if (L.spoiler === 'lip') c.aero.ClA += 0.1;
  return c;
}

Object.assign(Vehicle.prototype, {
  /** Neue Abstimmung übernehmen (nach Upgrades). */
  setConfig(cfg) {
    this.cfg = cfg; this.drivetrain.cfg = cfg;
    this.mass = cfg.mass; this.invMass = 1 / cfg.mass;
    const { w, h, l } = cfg.inertiaBox, m = cfg.mass;
    this.invInertia.set(1 / (m / 12 * (h * h + l * l)), 1 / (m / 12 * (w * w + l * l)), 1 / (m / 12 * (w * w + h * h) * 1.15));
    this.staticLoad = m * 9.81 / 4;
    this.drivetrain.redlineOmega = cfg.motor.redline * Math.PI / 30;
    this.drivetrain.baseOmega = cfg.motor.maxPower / cfg.motor.maxTorque;
    for (const wh of this.wheels) wh.k = wh.front ? cfg.suspension.springFront : cfg.suspension.springRear;
  },
});

Object.assign(CarModel.prototype, {
  /** Felgen-Design neu aufbauen. */
  buildRims(style) {
    const W = this.cfg.wheelWidth;
    for (const m of this.wheels) {
      const g = m.rimGrp;
      while (g.children.length) g.remove(g.children[0]);
      const x = m.side * (W / 2 - 0.01);
      g.add(new THREE.Mesh(this.rimBarrelGeo, this.rimMat));
      const face = new THREE.Mesh(this.faceGeo, this.faceMat); face.position.x = m.side * (W / 2 - 0.02); if (m.side < 0) face.rotation.y = Math.PI; g.add(face);
      const add = (geo, rx, rz = 0, r = 0, ang = 0) => { const s = new THREE.Mesh(geo, this.rimMat); s.position.set(x, Math.cos(ang) * r, Math.sin(ang) * r); s.rotation.x = rx; s.rotation.z = rz; g.add(s); };
      if (style === 'sport5') for (let k = 0; k < 5; k++) add(this.spokeGeos.sport, k * Math.PI * 2 / 5);
      else if (style === 'multi') for (let k = 0; k < 10; k++) add(this.spokeGeos.thin, k * Math.PI / 10 * 2 / 2);
      else if (style === 'turbine') for (let k = 0; k < 14; k++) { const a = k * Math.PI * 2 / 14; add(this.spokeGeos.fin, a + 0.5, 0, 0.14, a); }
      else if (style === 'mesh') for (let k = 0; k < 8; k++) { add(this.spokeGeos.thin, k * Math.PI / 8 + 0.26); add(this.spokeGeos.thin, k * Math.PI / 8 - 0.26); }
      const cap = new THREE.Mesh(this.capGeo, this.rimMat); cap.position.x = x + m.side * 0.01; g.add(cap);
    }
  },

  /** Aussehen übernehmen (Lack, Felgen, Licht, Spoiler, Innenraum). */
  applyLook(L) {
    this.setBodyStyle(L.model || 'roadster');
    this.paint.color.set(L.paint);
    const fin = { glossy: [0.12, 0.3, 1], metallic: [0.6, 0.36, 0.85], matt: [0.05, 0.78, 0] }[L.finish] || [0.12, 0.3, 1];
    this.paint.metalness = fin[0]; this.paint.roughness = fin[1];
    if ('clearcoat' in this.paint) this.paint.clearcoat = fin[2];
    if (this._rimStyle !== L.rims) { this.buildRims(L.rims); this._rimStyle = L.rims; }
    this.rimMat.color.set(L.rimColor);
    // Unterbodenbeleuchtung
    if (!this.glow) {
      this.glowMat = new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      this.glow = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 6.4).rotateX(-Math.PI / 2), this.glowMat);
      this.glow.position.y = 0.04; this.glow.renderOrder = 2; this.body.add(this.glow);
      if (this.q.headlights) { this.glowLight = new THREE.PointLight(0xffffff, 0, 6, 1.5); this.glowLight.position.y = 0.15; this.body.add(this.glowLight); }
    }
    const ug = L.underglow !== 'off';
    this.glow.visible = ug;
    if (ug) this.glowMat.color.set(L.underglow);
    if (this.glowLight) { this.glowLight.color.set(ug ? L.underglow : '#000000'); this.glowLight.intensity = ug ? 4 : 0; }
    // Spoiler
    if (!this.spoilers) {
      const carbon = new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.35, metalness: 0.4 });
      const lip = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.22), this.paint); lip.position.set(0, 0.885, 2.1); lip.rotation.x = -0.18;
      const wing = new THREE.Group();
      for (const s of [-1, 1]) { const up = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.32, 0.14), carbon); up.position.set(s * 0.52, 1.02, 1.98); wing.add(up);
        const ep = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.44), carbon); ep.position.set(s * 0.89, 1.19, 2.0); wing.add(ep); }
      const blade = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.035, 0.42), carbon); blade.position.set(0, 1.19, 2.0); blade.rotation.x = -0.12; wing.add(blade);
      for (const o of [lip, wing]) { o.traverse((c) => { c.castShadow = true; }); this.body.add(o); }
      this.spoilers = { lip, wing };
    }
    this.spoilers.lip.visible = L.spoiler === 'lip'; this.spoilers.wing.visible = L.spoiler === 'wing';
    // Innenraum
    this.seatMat.color.set(L.seat);
    this.ambientMat.color.set(L.ambient);
    for (const [k, g] of Object.entries(this.swVariants)) g.visible = k === L.wheel;
    const th = DISPLAY_THEMES[L.display] || DISPLAY_THEMES.cyan;
    this.screenStyle.accent = th[0]; this.screenStyle.bg = th[1];
  },
});

// ============================== Garage ==============================
/** Ausstellungsraum: Drehteller, Studiolicht, Kauf von Upgrades und Optik. */
class Garage {
  constructor(game) {
    this.g = game; this.open = false;
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d11);
    scene.fog = new THREE.Fog(0x0b0d11, 18, 40);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    // Studio-Umgebung für Reflexionen: dunkler Raum mit hellen Lichtflächen
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 24, 12), new THREE.MeshBasicMaterial({ color: 0x15171c, side: THREE.BackSide })));
    for (const [x, y, z, w, h] of [[0, 9, 0, 16, 2.4], [-9, 5, -4, 3, 7], [9, 5, 4, 3, 7], [0, 4, 12, 12, 3]]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
      pl.position.set(x, y, z); pl.lookAt(0, 0, 0); env.add(pl);
    }
    const pm = new THREE.PMREMGenerator(game.renderer);
    scene.environment = pm.fromScene(env, 0.02).texture; pm.dispose();
    scene.environmentIntensity = 0.5;
    // Raum
    const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1a1c21, roughness: 0.22, metalness: 0.4 }));
    floor.receiveShadow = true; scene.add(floor);
    this.turn = new THREE.Group(); scene.add(this.turn);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.3, 0.12, 64), new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.35, metalness: 0.6 }));
    disc.position.y = 0.06; disc.receiveShadow = true; this.turn.add(disc);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(4.25, 0.03, 8, 96).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x36e0ff, toneMapped: false }));
    rim.position.y = 0.12; this.turn.add(rim);
    for (let k = 0; k < 7; k++) {   // Lichtleisten an der Decke
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.05, 9), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
      strip.position.set(-6 + k * 2, 7, 0); scene.add(strip);
    }
    scene.add(new THREE.HemisphereLight(0xd8e4ff, 0x202228, 0.6));
    const key = new THREE.SpotLight(0xffffff, 240, 30, 0.55, 0.6, 1.2); key.position.set(4, 8, 5); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); scene.add(key);
    const rimL = new THREE.SpotLight(0x9fd8ff, 200, 30, 0.6, 0.7, 1.2); rimL.position.set(-6, 5, -6); scene.add(rimL);
    const fill = new THREE.PointLight(0xffe0c0, 30, 20, 1.5); fill.position.set(-5, 3, 6); scene.add(fill);
    // Ausstellungsauto (eigene Kopie, Änderungen sofort sichtbar)
    this.car = new CarModel(CONFIG.car, { ...game.q, physicalPaint: true, bevelSegs: 3, headlights: true });
    this.car.root.position.y = CONFIG.car.cgHeight + 0.12;
    this.car.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.turn.add(this.car.root);
    this.fake = { wheels: [0, 1, 2, 3].map(() => ({ grounded: true, suspLen: 0.27, steer: 0, omega: 0, spin: 0 })), steerAngle: 0, swAngle: 0, braking: false, reversing: false,
      flying: false, landing: false, altitude: 0, boosting: false, throttle: 0, climbIn: 0 };
    this.car.update(this.fake, 0.016);
    this.yaw = 0.7; this.pitch = 0.18; this.dist = 9.5; this.drag = null; this.spin = 0;
    this.tab = 'perf';
    this.bindUI();
  }

  bindUI() {
    const view = document.getElementById('gView');
    view.addEventListener('pointerdown', (e) => { e.preventDefault(); const [x, y] = View.toGame(e.clientX, e.clientY); this.drag = { id: e.pointerId, x, y }; try { view.setPointerCapture(e.pointerId); } catch (er) { /* egal */ } });
    view.addEventListener('pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      const [x, y] = View.toGame(e.clientX, e.clientY);
      this.yaw -= (x - this.drag.x) * 0.008; this.pitch = clamp(this.pitch + (y - this.drag.y) * 0.004, 0.02, 0.6);
      this.drag.x = x; this.drag.y = y; this.spin = 0;
    });
    const up = () => { this.drag = null; };
    view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
    document.getElementById('gBack').addEventListener('click', () => this.close());
    document.querySelectorAll('#gTabs button').forEach((b) => b.addEventListener('click', () => { this.tab = b.dataset.tab; this.render(); }));
  }

  show() {
    this.open = true;
    this.g.paused = true; Input.releaseAll();
    document.body.classList.add('inGarage');
    document.getElementById('garage').hidden = false;
    this.car.applyLook(SaveData.data.look);
    this.render();
  }

  close() {
    this.open = false; this.preview = null;   // Vorschau verwerfen: gekauft bleibt nur, was bezahlt ist
    document.body.classList.remove('inGarage');
    document.getElementById('garage').hidden = true;
    // Upgrades und Optik ins Spiel übernehmen
    this.g.vehicle.setConfig(buildCarConfig());
    this.g.car.applyLook(SaveData.data.look);
    this.g.paused = false;
    this.g.resize();
  }

  buy(price) {
    if (SaveData.data.money < price) { toast('Nicht genug Geld – verdiene welches mit Missionen oder Polizei-Fluchten.', 2200); return false; }
    SaveData.addMoney(-price); Haptics.pulse(25);
    return true;
  }

  /** Optik-Option wählen (einmalig kaufen, falls kostenpflichtig). */
  pick(key, val) {
    const id = key === 'underglow' ? 'underglow' : `${key}:${val}`;
    const price = key === 'underglow' ? (val === 'off' ? 0 : COSMETIC_PRICES.underglow) : (COSMETIC_PRICES[id] || 0);
    const owned = SaveData.data.owned;
    if (price && !owned.includes(id)) {
      // Noch nicht gekauft: erster Tipp = Vorschau am Auto (auch ohne genug Geld), zweiter Tipp = kaufen
      const pv = this.preview;
      if (!pv || pv.key !== key || pv.val !== val) {
        this.preview = { key, val, price };
        this.car.applyLook({ ...SaveData.data.look, [key]: val });
        toast(`Vorschau – ${SaveData.data.money >= price ? 'nochmal tippen zum Kaufen (' + fmtMoney(price) + ')' : 'kostet ' + fmtMoney(price) + ', du hast ' + fmtMoney(SaveData.data.money)}`, 2200);
        if (key === 'wheel') this.wheelView = 6;
        this.render();
        return;
      }
      if (!this.buy(price)) return;
      owned.push(id);
    }
    this.preview = null;
    if (key === 'wheel') this.wheelView = 4;
    SaveData.data.look[key] = val; SaveData.save();
    this.car.applyLook(SaveData.data.look);
    this.render();
  }

  render() {
    document.getElementById('gMoney').textContent = '💰 ' + fmtMoney(SaveData.data.money);
    document.querySelectorAll('#gTabs button').forEach((b) => b.classList.toggle('sel', b.dataset.tab === this.tab));
    const box = document.getElementById('gList'); box.innerHTML = '';
    const L = this.preview ? { ...SaveData.data.look, [this.preview.key]: this.preview.val } : SaveData.data.look, owned = SaveData.data.owned;
    const row = (title, sub, content) => { const r = document.createElement('div'); r.className = 'gRow'; r.innerHTML = `<div class="gHead"><b>${title}</b><small>${sub || ''}</small></div>`; r.appendChild(content); box.appendChild(r); };
    const seg = (key, opts) => {
      const s = document.createElement('div'); s.className = 'seg gSeg';
      for (const [val, label] of opts) {
        const b = document.createElement('button');
        const id = `${key}:${val}`, price = COSMETIC_PRICES[id];
        b.innerHTML = label + (price && !owned.includes(id) ? `<small>${fmtMoney(price)}</small>` : '');
        b.classList.toggle('sel', L[key] === val);
        b.addEventListener('click', () => this.pick(key, val));
        s.appendChild(b);
      }
      return s;
    };
    const swatches = (key, cols, picker) => {
      const s = document.createElement('div'); s.className = 'gSw';
      for (const c of cols) {
        const b = document.createElement('button'); b.style.background = c === 'off' ? 'repeating-linear-gradient(45deg,#333 0 4px,#555 4px 8px)' : c;
        b.classList.toggle('sel', L[key] === c); b.addEventListener('click', () => this.pick(key, c)); s.appendChild(b);
      }
      if (picker) {
        const inp = document.createElement('input'); inp.type = 'color'; inp.value = L[key]; inp.id = 'gPick_' + key;
        inp.addEventListener('input', () => { SaveData.data.look[key] = inp.value; this.car.applyLook(SaveData.data.look); });
        inp.addEventListener('change', () => { SaveData.save(); this.render(); });
        s.appendChild(inp);
      }
      return s;
    };
    if (this.tab === 'perf') {
      for (const u of UPGRADES) {
        const lvl = SaveData.data.upgrades[u.key] || 0, max = u.prices.length;
        const wrap = document.createElement('div'); wrap.className = 'gUp';
        wrap.innerHTML = `<span class="pips">${'●'.repeat(lvl)}${'○'.repeat(max - lvl)}</span>`;
        const b = document.createElement('button'); b.className = 'gBuy';
        if (lvl >= max) { b.textContent = 'MAX'; b.disabled = true; }
        else { b.textContent = fmtMoney(u.prices[lvl]); b.disabled = SaveData.data.money < u.prices[lvl]; }
        b.addEventListener('click', () => { if (this.buy(u.prices[lvl])) { SaveData.data.upgrades[u.key] = lvl + 1; SaveData.save(); this.render(); } });
        wrap.appendChild(b);
        row(u.name, u.desc, wrap);
      }
      const c = buildCarConfig();
      const info = document.createElement('div'); info.className = 'gInfo';
      info.textContent = `Leistung ${Math.round(c.motor.maxPower / 735.5)} PS · Drehmoment ${Math.round(c.motor.maxTorque)} Nm · Gewicht ${Math.round(c.mass)} kg · Grip ${c.tire.mu.toFixed(2)} · Boost ${Math.round(c.boost.force / 1000)} kN`;
      box.appendChild(info);
    } else if (this.tab === 'look') {
      row('Fahrzeug', 'Karosserie (gleiche Technik, andere Form)', seg('model', [['roadster', 'Roadster'], ['limo', 'Sportlimousine'], ['kombi', 'Kombi'], ['suv', 'SUV']]));
      row('Lackfarbe', 'Farbwähler oder Vorschlag', swatches('paint', ['#f2f2ee', '#101114', '#8c0612', '#0d3b8c', '#1e5c3a', '#c9a227', '#ff6a00', '#7a7f87', '#5a2d82', '#d81b60'], true));
      row('Lack-Art', 'Glanz, Metallic oder Matt', seg('finish', [['glossy', 'Glanz'], ['metallic', 'Metallic'], ['matt', 'Matt']]));
      row('Felgen', 'Design', seg('rims', [['sport5', '5-Speichen'], ['multi', 'Vielspeiche'], ['turbine', 'Turbine'], ['mesh', 'Gitter']]));
      row('Felgenfarbe', '', swatches('rimColor', ['#c8ccd2', '#1a1b1e', '#c9a227', '#8a5a2b', '#36e0ff']));
      row('Unterbodenlicht', SaveData.data.owned.includes('underglow') ? '' : fmtMoney(COSMETIC_PRICES.underglow) + ' (einmalig)', swatches('underglow', ['off', '#36e0ff', '#ff2bd6', '#7c5cff', '#2bff88', '#ff4b2b']));
      row('Spoiler', 'Flügel: mehr Abtrieb, etwas mehr Luftwiderstand', seg('spoiler', [['none', 'Ohne'], ['lip', 'Lippe'], ['wing', 'Flügel']]));
    } else {
      row('Sitzfarbe', '', swatches('seat', ['#2a2a2e', '#e9e4da', '#7a1b1b', '#5a3a22', '#1c2b4a', '#3a3a3a']));
      row('Lenkrad', 'im Cockpit sichtbar', seg('wheel', [['round', 'Rund'], ['yoke', 'Yoke'], ['sport', 'Sport']]));
      row('Ambientelicht', '', swatches('ambient', ['#36e0ff', '#ff2bd6', '#ffb02e', '#7c5cff', '#2bff88', '#ffffff']));
      row('Display-Design', 'Fahrer- und Mitteldisplay', seg('display', [['cyan', 'Cyan'], ['amber', 'Amber'], ['violet', 'Violett'], ['green', 'Grün']]));
    }
  }

  update(dt) {
    if (!this.drag) { this.spin = Math.min(1, this.spin + dt * 0.3); this.yaw += dt * 0.18 * this.spin; }
    const c = this.camera;
    c.aspect = View.w / View.h;
    // Auto links im Bild (rechts ist das Menü)
    c.setViewOffset(View.w, View.h, View.w * 0.18, 0, View.w, View.h);
    c.position.set(Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist, 1.2 + Math.sin(this.pitch) * this.dist, Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist);
    // Lenkrad-Vorschau: Kamera schaut von oben hinter dem Fahrersitz ins Cockpit
    if (this.wheelView > 0) {
      this.wheelView -= dt;
      const w = this._wp || (this._wp = new THREE.Vector3()); this.car.steeringWheel.getWorldPosition(w);
      c.position.lerp(this._wc || (this._wc = new THREE.Vector3()), 0).set(w.x + 0.15, w.y + 0.75, w.z + 1.15);
      c.lookAt(w.x, w.y - 0.05, w.z); c.updateProjectionMatrix();
      if (this.car.steeringWheel) this.car.steeringWheel.rotation.z = Math.sin(performance.now() / 600) * 0.5;   // dreht zur Ansicht leicht hin und her
      return;
    }
    c.lookAt(0, 0.75, 0); c.updateProjectionMatrix();
    if (this.car.updateScreens && (this._st = (this._st || 0) - dt) <= 0) { this._st = 0.3; this.car.updateScreens(this.fake.speed ? this.fake : Object.assign(this.fake, { forwardSpeed: 0, drivetrain: this.g.vehicle.drivetrain, cfg: this.g.vehicle.cfg, latAccel: 0, longAccel: 0, tractionControl: true })); }
  }
}

export { BASE_CAR, UPGRADES, LOOK_DEFAULT, COSMETIC_PRICES, DISPLAY_THEMES, buildCarConfig, Garage };
