import * as THREE from 'three';
import { CONFIG, clamp, damp, Settings, QUALITY } from './config.js';
import { Haptics, Input, View, toast } from './input.js';
import { tick } from './world/noise.js';
import { WORLD, World, makeBlobTexture } from './world/world.js';
import { TrafficSystem } from './world/traffic.js';
import { Environment, Minimap } from './environment.js';
import { Vehicle } from './vehicle/vehicle.js';
import { CarModel, SkidMarks } from './vehicle/carmodel.js';
import { CamInput, CameraRig } from './camera.js';
import { HUD } from './hud.js';
import { Particles, Grass } from './fx.js';
import { SoundFX, Music } from './audio.js';
import { SaveData, fmtMoney, POLICE_LEVELS, PoliceSystem } from './police.js';
import { MissionSystem } from './missions.js';
import { buildCarConfig, Garage } from './garage.js';
import { Tutorial, DynRes } from './menu.js';
import { UI } from './ui.js';
import { Weather, makeMountainRing, Scenery, buildRoadFurniture, makeSunFlare } from './weather.js';
import { game } from './main.js';

// ============================== Game ==============================
class Game {
  constructor() {
    this.q = QUALITY[Settings.data.quality] || QUALITY.medium;
    this.canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: this.q.antialias, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3400);
    this.env = new Environment(this);
    this.paused = true; this.ready = false;
  }

  /** Welt erzeugen und alles aufbauen (mit Fortschrittsanzeige). */
  async init(progress) {
    this.world = new World(this.q);
    await this.world.generate(progress);
    progress(0.8, 'Welt aufbauen …'); await tick();
    this.world.build(this.scene, this.camera);
    progress(0.9, 'Verkehr einsetzen …'); await tick();
    this.vehicle = new Vehicle(this.world, CONFIG.car);
    this.car = new CarModel(CONFIG.car, this.q);
    this.scene.add(this.car.root);
    this.skid = new SkidMarks(this.scene);
    this.rig = new CameraRig(this.camera, this.world);
    this.screenTimer = 0;
    CamInput.init(this.canvas);
    // Start: Stadtstraße, Blick nach Osten
    this.spawnAt(WORLD.city.x0 + 250, WORLD.city.z0 + 300, -Math.PI / 2);
    this.traffic = new TrafficSystem(this.world, this.scene, this.q.traffic, this.q.parked || 0);
    this.traffic.spawnAll(this.vehicle.pos);
    this.minimap = new Minimap(this.world);
    this.particles = new Particles(this.scene, this.q.particles);
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: makeBlobTexture(), color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }));
    this.blob.scale.set(2.35, 1, 4.95); this.blob.renderOrder = 1;
    this.scene.add(this.blob);
    this.grass = new Grass(this.world, this.scene, this.q);
    // Mehr Realismus: Bergkulisse, Felsen/Büsche, Straßenausstattung, Sonnenreflex, Wetter
    this.mountains = makeMountainRing(); this.scene.add(this.mountains);
    this.scenery = new Scenery(this.world, this.scene, this.q);
    this.furniture = buildRoadFurniture(this.world, this.scene);
    this.flare = this.q.clouds ? makeSunFlare() : null;
    if (this.flare) this.scene.add(this.flare);
    this.weather = new Weather(this);
    this.sound = new SoundFX();
    this.music = new Music(this.sound);
    this.police = new PoliceSystem(this.world, this.scene, this.q, this.sound);
    this._camR = new THREE.Vector3();
    this.missions = new MissionSystem(this);
    // Gekaufte Upgrades und Optik übernehmen
    this.vehicle.setConfig(buildCarConfig());
    this.car.applyLook(SaveData.data.look);
    const startSound = () => { this.sound.start(); if (!this.menuOpen) this.music.start(); };
    window.addEventListener('pointerdown', startSound); window.addEventListener('keydown', startSound);
    this.env.setupBloom();
    this.timeOfDay = null;
    this.applySettings();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
    this.acc = 0; this.last = performance.now();
    this.frames = 0; this.fpsTime = 0; this.fps = 0;
    this.stats = { zeroTo100: 0, vmax: 0, launchT: -1 };
    this.waterT = 0;
    this._ip = new THREE.Vector3(); this._iq = new THREE.Quaternion();
    document.addEventListener('visibilitychange', () => { this.last = performance.now(); this.acc = 0; });
    // Shader vorab kompilieren (vermeidet Ruckler beim ersten Bild)
    progress(0.97, 'Shader vorbereiten …'); await tick();
    this.rig.update(0.016, this.vehicle.pos, this.vehicle.quat, this.vehicle);
    this.world.update(0.016, this.camera, this.vehicle.pos);
    try { this.renderer.compile(this.scene, this.camera); } catch (e) { /* optional */ }
    this.ready = true; this.paused = false;
    requestAnimationFrame((t) => this.frame(t));
  }

  spawnAt(x, z, yaw) {
    const p = this.world.nearestRoadPose(x, z, yaw);
    this.vehicle.reset(new THREE.Vector3(p.x, 0, p.z), p.yaw);
    this.rig.initialized = false;
  }

  applySettings() {
    const s = Settings.data;
    this.q = QUALITY[s.quality] || QUALITY.medium;
    if (!this.vehicle) return;
    // nur Automatik (E-Hypercar)
    this.vehicle.drivetrain.manual = false;
    if (this.vehicle.drivetrain.gear === 0) this.vehicle.drivetrain.gear = 1;
    this.vehicle.tractionControl = !!s.tractionControl;
    document.body.classList.toggle('tilt', s.steering === 'tilt');
    this.renderer.shadowMap.enabled = this.q.shadows;
    this.env.sun.castShadow = this.q.shadows;
    if (this.q.shadows && this.env.sun.shadow.mapSize.x !== this.q.shadowSize) {
      this.env.sun.shadow.mapSize.set(this.q.shadowSize, this.q.shadowSize);
      this.env.sun.shadow.map?.dispose(); this.env.sun.shadow.map = null;
    }
    if (s.timeOfDay !== this.timeOfDay || s.weather !== this.weather.type) this.setTimeOfDay(s.timeOfDay);
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    this.resize();
  }

  setTimeOfDay(mode) {
    this.timeOfDay = mode;
    const night = mode === 'night', lights = mode !== 'day';      // abends sind Laternen und Scheinwerfer schon an
    this.env.setTime(mode);
    this.world.setNight(lights);
    this.traffic.setNight(lights);
    this.car.setHeadlights(true, lights ? (this.q.headlights ? 320 : 480) * (night ? 1 : 0.6) : 0);
    this.car.setBeams(night ? 1 : lights ? 0.4 : 0);
    this.furniture.setNight(lights);
    if (mode === 'dusk') this.mountains.material.color.setRGB(1.0, 0.72, 0.62); else this.mountains.material.color.setScalar(night ? 0.09 : 1);
    this.weather.apply(Settings.data.weather || 'clear');   // nach der Tageszeit, da es Licht/Nebel/Himmel anpasst
  }

  resize() {
    View.update();
    const w = View.w, h = View.h;
    Input.layout();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.pixelRatio) * DynRes.scale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.env.resize(w, h);
  }

  /** Einmalige Eingaben (Gangwechsel, Reset …) */
  handleActions() {
    const v = this.vehicle, d = v.drivetrain;
    if (Input.consume('KeyR')) this.resetCar();
    if (Input.consume('KeyC') || Input.consume('Camera')) this.nextCamera();
    if (Input.consume('KeyV')) this.toggleEgo();
    if (Input.consume('KeyP') && !this.missions.active) this.togglePolice();
    if (Input.consume('KeyF') || Input.consume('Fly')) {
      const r = v.toggleFly();
      if (r === 'up') { toast('Abheben – Joystick ↕ für die Höhe', 1600); Haptics.pulse(25); }
      else if (r === 'land') toast('Landeanflug', 1000);
      else toast('Flugenergie leer – lädt am Boden auf', 1500);
    }
    if (Input.consume('KeyT')) { Settings.data.telemetry = !Settings.data.telemetry; Settings.save(); UI.sync(); }
    if (Input.consume('KeyG')) this.openGarage();
    if (Input.consume('KeyN')) { Settings.data.timeOfDay = this.timeOfDay === 'night' ? 'day' : 'night'; Settings.save(); this.applySettings(); UI.sync(); }
  }

  /** Verfolgung starten/abbrechen. */
  togglePolice() {
    if (this.police.active) { this.police.stop(false); toast('Verfolgung abgebrochen', 1200); }
    else {
      const lvl = Settings.data.policeLevel || 'normal';
      this.police.start(lvl, this.vehicle, this.camera);
      toast(`🚨 Polizei: ${POLICE_LEVELS[lvl].name} – entkomme ihnen!`, 2200);
      Haptics.pulse(30);
    }
    document.getElementById('btnPolice').classList.toggle('on', this.police.active);
  }

  showResult(r) {
    document.getElementById('btnPolice').classList.remove('on');
    const esc = r.result === 'escaped';
    document.getElementById('resTitle').textContent = esc ? 'ENTKOMMEN!' : 'ERWISCHT';
    document.getElementById('resTitle').style.color = esc ? '#7dffa8' : '#ff6b7a';
    const mm = Math.floor(r.time / 60), ss = Math.round(r.time % 60);
    document.getElementById('resText').textContent = `${r.level} · Fluchtzeit ${mm}:${String(ss).padStart(2, '0')} · Fahndungslevel ${'★'.repeat(r.wanted)}`;
    document.getElementById('resMoney').textContent = esc ? '+ ' + fmtMoney(r.reward) : 'kein Geld';
    document.getElementById('result').hidden = false;
    this.paused = true; Input.releaseAll();
    Haptics.pulse(esc ? 40 : 80);
  }

  toggleEgo() {
    const m = this.rig.toggleEgo();
    toast(CameraRig.LABELS[m], 900);
    document.getElementById('btnEgo').classList.toggle('on', m === 'cockpit');
    Haptics.pulse(10);
  }

  nextCamera() {
    const m = this.rig.next();
    document.getElementById('btnEgo').classList.toggle('on', m === 'cockpit');
    toast(CameraRig.LABELS[m], 900);
    Haptics.pulse(10);
  }

  /** Zurück auf die nächste Straße (rechte Spur, aktuelle Fahrtrichtung). */
  resetCar() {
    const v = this.vehicle;
    this.spawnAt(v.pos.x, v.pos.z, v.yaw());
  }

  /** Kamerafahrt um das Auto im Hauptmenü. */
  menuCamera(dt) {
    this.menuA = (this.menuA || 0.6) + dt * 0.12;
    const c = this.camera, p = this._ip, a = this.menuA;
    c.position.set(p.x + Math.sin(a) * 8.5, p.y + 1.6 + Math.sin(a * 0.7) * 0.5, p.z + Math.cos(a) * 8.5);
    c.lookAt(p.x - Math.cos(a) * 1.5, p.y + 0.4, p.z + Math.sin(a) * 1.5);
    if (c.fov !== 55) { c.fov = 55; c.updateProjectionMatrix(); }
  }

  openGarage() {
    if (this.missions.active) { toast('Erst die Mission beenden', 1200); return; }
    if (this.police.active) { this.police.stop(false); document.getElementById('btnPolice').classList.remove('on'); }
    if (!this.garage) this.garage = new Garage(this);
    this.garage.show();
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    let dt = (now - this.last) / 1000; this.last = now;
    if (dt > 0.1) dt = 0.1;               // nach Tab-Wechsel o. Ä. nicht „nachholen“
    if (this.garage?.open) {               // Garage: eigene Szene
      this.garage.update(dt);
      this.renderer.render(this.garage.scene, this.garage.camera);
      return;
    }
    const fixed = 1 / CONFIG.physicsHz;
    const v = this.vehicle;

    Input.update();
    this.handleActions();
    if (!this.paused) {
      v.processInput(Input.state, dt);
      this.acc += dt;
      let steps = 0;
      while (this.acc >= fixed && steps < CONFIG.maxSubSteps) {
        v.step(fixed);
        this.traffic.collidePlayer(v);
        this.police.collidePlayer(v);
        // KI-Rennwagen sind fest (gleiche Kontaktberechnung wie bei der Polizei)
        const opps = this.missions.active?.opps;
        if (opps) {
          if (!this._oppCtx) this._oppCtx = { active: true, units: [], geo: { W: 1.96, L: 4.5 }, resolve: PoliceSystem.prototype.resolve, rams: 0, time: 0, w: this.world };
          this._oppCtx.units = opps.map((o) => { o.active = true; return o; });
          PoliceSystem.prototype.collidePlayer.call(this._oppCtx, v);
        }
        this.acc -= fixed; steps++;
      }
      if (steps === CONFIG.maxSubSteps) this.acc = 0;
      this.traffic.update(dt, v, this.camera);
      const res = this.police.update(dt, v, this.camera);
      if (res && !this.missions.onPoliceResult(res)) this.showResult(res);
      this.missions.update(dt);
      Tutorial.update(dt, v);
      document.body.classList.toggle('inMission', !!this.missions.active);
      this.trackStats(dt);
      // Im See gelandet → nach kurzer Zeit zurück auf die Straße
      if (v.inWater > 0.5) {
        if ((this.waterT += dt) > 1.8) { this.waterT = 0; this.resetCar(); toast('Abgeschleppt: zurück auf die Straße', 1800); }
      } else this.waterT = 0;
    }
    Input.endFrame();

    // Darstellung zwischen letztem und aktuellem Physikzustand interpolieren
    const alpha = this.acc / fixed;
    this._ip.lerpVectors(v.prevPos, v.pos, alpha);
    this._iq.slerpQuaternions(v.prevQuat, v.quat, alpha);
    this.car.root.position.copy(this._ip);
    this.car.root.quaternion.copy(this._iq);
    this.car.update(v, this.paused ? 0 : dt);
    for (let i = 0; i < 4; i++) this.skid.track(i, v.wheels[i], v, this.world);
    this.skid.flush();
    if (this.menuOpen) this.menuCamera(dt); else this.rig.update(dt, this._ip, this._iq, v);
    // Kontaktschatten unter dem Auto (wird mit der Höhe schwächer)
    { const gy = this.world.sample(this._ip.x, this._ip.z, undefined, this._ip.y), alt = this._ip.y - 0.45 - gy;
      this.blob.position.set(this._ip.x, gy + 0.05, this._ip.z); this.blob.rotation.y = v.yaw();
      this.blob.material.opacity = 0.62 * clamp(1 - alt / 5, 0, 1); this.blob.visible = alt < 5; }
    if (this.rig.mode === 'cockpit' && (this.screenTimer += dt) > 0.12) { this.screenTimer = 0; this.car.updateScreens(v); }

    this.world.update(dt, this.camera, this._ip);
    this.env.update(dt, this._ip, this.camera.position);
    this.minimap.draw(dt, v, this.traffic);
    this.grass.update(dt, this.camera.position);
    this.scenery.update(this.camera.position);
    this.weather.update(dt, this.camera.position, v);
    this.car.setBeamHaze(1 + this.weather.rain * 2.5 + (this.weather.type === 'fog' ? 3.5 : 0) + (this.weather.type === 'cloudy' ? 0.5 : 0));
    if (this.flare) {
      this.flare.visible = this.timeOfDay !== 'night' && this.weather.W.cover < 1.8 && this.rig.mode !== 'cockpit';
      this.flare.position.copy(this.camera.position).addScaledVector(this.env.sunDir, 2400);
    }
    this.emitEffects(dt);
    this.particles.setScale(this.renderer.domElement.height / (2 * Math.tan(this.camera.fov * Math.PI / 360)));
    this.particles.update(dt);
    this.sound.update(v);
    this._camR.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.sound.updatePolice(this.police, this.camera.position, v.vel, this._camR, this.police.time);
    // Boost: weiteres Sichtfeld, leichtes Wackeln
    this.rig.fovExtra = damp(this.rig.fovExtra, v.boosting ? 15 : 0, v.boosting ? 5 : 2.5, dt);
    if (v.boosting) this.rig.shake = Math.max(this.rig.shake, 0.12);
    if (document.body.classList.contains('flying') !== v.flying) { document.body.classList.toggle('flying', v.flying); if (Input.stick.id === null) Input.placeStick(null); }

    if (v.lastImpact > 0) {
      Haptics.pulse(Math.min(60, v.lastImpact * 6));
      this.rig.addShake(clamp(v.lastImpact * 0.07, 0, 1));
      v.lastImpact = 0;
    }

    this.env.render(this.camera);
    DynRes.update(this, dt);

    // FPS
    this.frames++; this.fpsTime += dt;
    if (this.fpsTime >= 0.5) { this.fps = Math.round(this.frames / this.fpsTime); this.frames = 0; this.fpsTime = 0; }
    HUD.update(v, this.fps);
    HUD.telemetry(v, this.stats);
  }

  /** Partikel und Geräusche aus dem Fahrzustand und aus Welt-Ereignissen. */
  emitEffects(dt) {
    const v = this.vehicle, P = this.particles, w = this.world, rnd = Math.random;
    const k = clamp(dt * 60, 0.3, 3);          // bildratenunabhängig
    for (const wh of v.wheels) {
      if (!wh.grounded) continue;
      const c = wh.contact;
      if (wh.grip >= 1) {
        if (wh.sliding && wh.slideAmount > 0.12 && v.speed > 3 && rnd() < wh.slideAmount * 0.8 * k) P.emit('smoke', c.x, c.y + 0.25, c.z, v.vel.x * 0.25, 0.8, v.vel.z * 0.25, 1, 1.2);
      } else if (v.speed > 4 && rnd() < Math.min(1, v.speed / 22) * 0.45 * k) {
        P.emit('dust', c.x, c.y + 0.2, c.z, v.vel.x * 0.2, 0.6, v.vel.z * 0.2, 1, 1.4);
      }
    }
    if (v.boosting) {
      const f = this._fxv || (this._fxv = new THREE.Vector3());
      for (const n of this.car.flames) {
        n.getWorldPosition(f);
        const back = this._fxb || (this._fxb = new THREE.Vector3()); back.set(0, 0, 1).applyQuaternion(v.quat);
        P.emit('plasma', f.x, f.y, f.z, v.vel.x + back.x * 18, v.vel.y + back.y * 18, v.vel.z + back.z * 18, 2, 0.5);
      }
    }
    if (v.flying && v.altitude < 9) {
      const g = w.sample(v.pos.x, v.pos.z), water = g < w.waterLevel;
      const strength = 1 - v.altitude / 9;
      for (let i = 0; i < 3 * k; i++) {
        if (rnd() > strength) continue;
        const a = rnd() * 6.28;
        P.emit(water ? 'splash' : 'dust', v.pos.x + Math.cos(a) * 1.5, Math.max(g, w.waterLevel) + 0.2, v.pos.z + Math.sin(a) * 1.5, Math.cos(a) * 9, 0.6, Math.sin(a) * 9, 1, 0.6);
      }
    }
    if (v.inWater > 0.1 && v.speed > 1.5 && rnd() < 0.8 * k) P.emit('splash', v.pos.x, w.waterLevel + 0.2, v.pos.z, v.vel.x * 0.3, 3 + v.speed * 0.2, v.vel.z * 0.3, 3, 1.5);
    // Ereignisse aus der Welt (Aufprall, Baum, Kratzen)
    for (const e of w.fx) {
      this.missions.onWorldEvent(e);
      if (e.type === 'spark') {
        P.emit('spark', e.x, e.y, e.z, e.nx * 3, 2.5, e.nz * 3, Math.min(30, 6 + e.s * 2), 2.5);
        this.sound.impact(e.s, 'hit');
      } else if (e.type === 'scrape') {
        P.emit('spark', e.x, e.y, e.z, 0, 1.5, 0, 3, 1.5);
      } else if (e.type === 'tree') {
        P.emit('leaf', e.x, e.y + 5 * e.scale, e.z, e.vx * 0.15, 1, e.vz * 0.15, 45, 5);
        P.emit('chip', e.x, e.y, e.z, e.vx * 0.2, 3, e.vz * 0.2, 16, 2);
        P.emit('dust', e.x, e.y - 0.8, e.z, 0, 0.5, 0, 6, 2);
        this.sound.impact(e.s, 'tree');
        this.rig.addShake(clamp(e.s * 0.03, 0.15, 0.6));
        Haptics.pulse(35);
      } else if (e.type === 'treeLand') {
        P.emit('dust', e.x, e.y, e.z, 0, 0.8, 0, 14, 4);
        P.emit('leaf', e.x, e.y + 1, e.z, 0, 2, 0, 20, 4);
        this.sound.impact(5, 'hit');
      }
    }
    w.fx.length = 0;
    if (v.lastImpact > 3 && v.airTime === 0 && !v.flying) { /* Landung/Aufprall: etwas Staub */ P.emit('dust', v.pos.x, v.pos.y - 0.4, v.pos.z, 0, 0.5, 0, Math.min(12, v.lastImpact), 2); }
  }

  /** Messwerte zum Abstimmen: 0–100 km/h und Höchstgeschwindigkeit. */
  trackStats(dt) {
    const v = this.vehicle, s = this.stats;
    const spd = v.forwardSpeed;
    if (spd < 0.3 && v.throttle < 0.05) s.launchT = 0;
    else if (s.launchT >= 0 && v.throttle > 0) {
      s.launchT += dt;
      if (spd >= 100 / 3.6) { s.zeroTo100 = s.launchT; s.launchT = -1; }
    }
    if (spd > s.vmax) s.vmax = spd;
  }
}

export { Game };
