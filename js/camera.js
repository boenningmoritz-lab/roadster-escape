import * as THREE from 'three';
import { CONFIG, clamp, damp, Settings } from './config.js';
import { View } from './input.js';

// ============================== CamInput ==============================
/**
 * Kamera-Gesten auf der freien Fläche (alles, was kein Knopf/Joystick ist):
 * ein Finger wischt = Kamera drehen, zwei Finger = zoomen. Maus: ziehen + Mausrad.
 */
const CamInput = {
  pointers: new Map(), yaw: 0, pitch: 0, zoom: 1, lastTouch: -1e9, pinch: 0,
  init(el) {
    this.zoom = clamp(Number(Settings.data.camZoom) || 1, 0.55, 2.4);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* nicht kritisch */ }
      const [gx, gy] = View.toGame(e.clientX, e.clientY);
      this.pointers.set(e.pointerId, { x: gx, y: gy });
      this.pinch = this.pointers.size === 2 ? this.dist() : 0;
      this.lastTouch = performance.now();
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId); if (!p) return;
      const [gx, gy] = View.toGame(e.clientX, e.clientY);
      if (this.pointers.size === 1) {
        this.yaw -= (gx - p.x) * 0.0065;
        this.pitch = clamp(this.pitch + (gy - p.y) * 0.0045, -0.3, 1.15);
      }
      p.x = gx; p.y = gy;
      if (this.pointers.size === 2) {
        const d = this.dist();
        if (this.pinch > 0) this.zoom = clamp(this.zoom * this.pinch / d, 0.55, 2.4);
        this.pinch = d;
      }
      this.lastTouch = performance.now();
    });
    const up = (e) => {
      if (!this.pointers.delete(e.pointerId)) return;
      this.pinch = this.pointers.size === 2 ? this.dist() : 0;
      Settings.data.camZoom = Number(this.zoom.toFixed(2)); Settings.save();
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.001), 0.55, 2.4);
      Settings.data.camZoom = Number(this.zoom.toFixed(2)); Settings.save();
    }, { passive: false });
  },
  dist() { const [a, b] = [...this.pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; },
  /** Keine Berührung seit kurzer Zeit → Kamera darf zurückfahren. */
  idle() { return this.pointers.size === 0 && performance.now() - this.lastTouch > 1800; },
};

// ============================== CameraRig ==============================
/**
 * Kamera-Modi:
 *  chase   – Verfolger mit weicher Nachführung (Drift bleibt sichtbar)
 *  far     – weiter hinten/höher, mehr Übersicht
 *  cockpit – Ego-Perspektive vom Fahrersitz
 * Wackeln über addShake() (Kollisionen, harte Landungen, später Boost).
 */
class CameraRig {
  constructor(camera, world) {
    this.cam = camera; this.world = world;
    this.mode = CameraRig.MODES.includes(Settings.data.camMode) ? Settings.data.camMode : 'chase';
    this.pos = new THREE.Vector3(); this.look = new THREE.Vector3();
    this.heading = new THREE.Vector3(0, 0, -1);
    this._t = new THREE.Vector3(); this._f = new THREE.Vector3(); this._h = new THREE.Vector3();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ'); this._q = new THREE.Quaternion();
    this.initialized = false;
    this.shake = 0; this.time = 0;
    this.fovExtra = 0;              // Phase 6: Boost weitet das Sichtfeld
  }

  static MODES = ['chase', 'far', 'hood', 'cockpit'];
  static LABELS = { chase: 'Verfolger', far: 'Verfolger weit', hood: 'Motorhaube', cockpit: 'Ego-Perspektive (Cockpit)' };

  /** Direkt zwischen Ego-Perspektive und der letzten Außenansicht umschalten. */
  toggleEgo() {
    if (this.mode === 'cockpit') this.mode = this.lastOutside || 'chase';
    else { this.lastOutside = this.mode === 'hood' ? 'chase' : this.mode; this.mode = 'cockpit'; }
    Settings.data.camMode = this.mode; Settings.save();
    CamInput.yaw = 0; CamInput.pitch = 0; this.initialized = false;
    return this.mode;
  }

  next() {
    const i = CameraRig.MODES.indexOf(this.mode);
    this.mode = CameraRig.MODES[(i + 1) % CameraRig.MODES.length];
    Settings.data.camMode = this.mode; Settings.save();
    CamInput.yaw = 0; CamInput.pitch = 0;
    this.initialized = false;
    return this.mode;
  }

  addShake(a) { this.shake = Math.min(1.4, this.shake + a); }

  update(dt, carPos, carQuat, vehicle) {
    this.time += dt;
    // Nach kurzer Pause fährt die Kamera von selbst zurück hinter das Auto
    if (CamInput.idle()) {
      CamInput.yaw = damp(CamInput.yaw, 0, 2.6, dt);
      CamInput.pitch = damp(CamInput.pitch, 0, 2.6, dt);
    }
    CamInput.yaw = Math.atan2(Math.sin(CamInput.yaw), Math.cos(CamInput.yaw));
    this.shake *= Math.exp(-dt * 5.5);

    const inside = this.mode === 'cockpit' || this.mode === 'hood';
    const near = inside ? 0.05 : 0.1;
    if (this.cam.near !== near) { this.cam.near = near; this.cam.updateProjectionMatrix(); }

    if (inside) this.updateCockpit(dt, carPos, carQuat, vehicle);
    else this.updateChase(dt, carPos, carQuat, vehicle);

    // Wackeln (zwei überlagerte Sinus-„Rauschen“)
    if (this.shake > 0.002) {
      const t = this.time, a = this.shake;
      this.cam.rotateX((Math.sin(t * 43.1) + Math.sin(t * 27.3 + 1.7)) * 0.012 * a);
      this.cam.rotateY((Math.sin(t * 38.7 + 0.5) + Math.sin(t * 21.9)) * 0.012 * a);
      this.cam.rotateZ(Math.sin(t * 31.3 + 2.1) * 0.01 * a);
    }

    const speed = vehicle.speed;
    const baseFov = inside ? 72 + clamp(speed * 0.04, 0, 3) : 60 + clamp(speed * 0.13, 0, 16);
    const fov = baseFov + this.fovExtra;
    if (Math.abs(fov - this.cam.fov) > 0.05) { this.cam.fov = damp(this.cam.fov, fov, 3, dt); this.cam.updateProjectionMatrix(); }
  }

  updateChase(dt, carPos, carQuat, vehicle) {
    const far = this.mode === 'far';
    const f = this._f.set(0, 0, -1).applyQuaternion(carQuat); f.y = 0;
    if (f.lengthSq() < 1e-4) f.copy(this.heading); f.normalize();
    // Richtung folgt der Fahrzeugnase, aber etwas träge (Drift bleibt sichtbar)
    if (!this.initialized) this.heading.copy(f);
    this.heading.lerp(f, 1 - Math.exp(-dt * 4.5)).normalize();
    // Wischen: Kamera um das Auto drehen
    const a = CamInput.yaw, c = Math.cos(a), sn = Math.sin(a);
    const h = this._h.set(this.heading.x * c + this.heading.z * sn, 0, -this.heading.x * sn + this.heading.z * c);
    const speed = vehicle.speed;
    const zoom = CamInput.zoom;
    const fly = vehicle.flying ? 1 : 0;
    const dist = ((far ? 10 : 6.2) + clamp(speed * 0.018, 0, 1.6) + fly * 2.5) * zoom;
    const height = (far ? 3.4 : 1.9) * Math.sqrt(zoom) + clamp(speed * 0.004, 0, 0.4) + fly * 1.2;
    const pitch = CamInput.pitch;
    const target = this._t.copy(carPos).addScaledVector(h, -dist * Math.cos(pitch));
    target.y = carPos.y + height + dist * Math.sin(pitch);
    // nicht unter das Gelände
    const gh = this.world.sample(target.x, target.z) + 0.6;
    if (target.y < gh) target.y = gh;
    // Hauswände zwischen Auto und Kamera → Kamera näher heranholen
    if (this.world.cameraClip) {
      const from = (this._c ||= new THREE.Vector3()).copy(carPos); from.y += 1.0;
      const clip = this.world.cameraClip(from, target);
      if (clip < 1) { target.lerpVectors(from, target, clip); this.pos.lerp(target, 0.5); }
    }
    if (!this.initialized) { this.pos.copy(target); this.initialized = true; }
    const k = CamInput.idle() ? 9 : 22;          // beim Wischen direkt dem Finger folgen
    this.pos.x = damp(this.pos.x, target.x, k, dt);
    this.pos.z = damp(this.pos.z, target.z, k, dt);
    this.pos.y = damp(this.pos.y, target.y, CamInput.idle() ? 5 : 22, dt);
    this.look.copy(carPos).addScaledVector(h, far ? 3 : 2.2);
    this.look.y += far ? 0.5 : 0.75;
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
  }

  updateCockpit(dt, carPos, carQuat, vehicle) {
    // Kopf als gedämpftes Feder-Masse-System: folgt den g-Kräften mit leichter Verzögerung (Nackenmuskulatur)
    if (!this.headG) { this.headG = { x: 0, z: 0, vx: 0, vz: 0 }; }
    { const H = this.headG, k = 60, c = 11, h = Math.min(dt, 0.05);
      const tx = clamp(vehicle.latAccel, -1.8, 1.8), tz = clamp(-vehicle.longAccel, -1.8, 1.8);   // tz > 0: Bremsen → Kopf nach vorn
      H.vx += (k * (tx - H.x) - c * H.vx) * h; H.x += H.vx * h;
      H.vz += (k * (tz - H.z) - c * H.vz) * h; H.z += H.vz * h; }
    // Kopf auf dem Fahrersitz; leichtes Mitschwingen mit den g-Kräften
    const hood = this.mode === 'hood';
    const head = hood
      ? this._t.set(0, 0.98 - CONFIG.car.cgHeight, -0.95)
      : this._t.set(
        -0.33 - this.headG.x * 0.032,
        CONFIG.car.cockpitEyeY - CONFIG.car.cgHeight - Math.abs(this.headG.z) * 0.006,
        0.42 - this.headG.z * 0.04);
    // feines Vibrieren bei hohem Tempo / Boost (realistischer Eindruck von Geschwindigkeit)
    const vib = clamp((vehicle.speed - 30) / 60, 0, 1) * 0.004 + (vehicle.boosting ? 0.004 : 0);
    if (vib > 0) { head.y += Math.sin(this.time * 73) * vib; head.x += Math.sin(this.time * 61 + 1) * vib * 0.6; }
    head.applyQuaternion(carQuat).add(carPos);
    this.cam.position.copy(head);
    // Kopf neigt sich leicht gegen die Fliehkraft, nickt beim Bremsen
    this._e.set(-0.05 - CamInput.pitch * 0.6 - (hood ? 0 : this.headG.z * 0.012), CamInput.yaw * 1.2, hood ? 0 : this.headG.x * 0.018, 'YXZ');
    this.cam.quaternion.copy(carQuat).multiply(this._q.setFromEuler(this._e));
    this.initialized = false;      // beim Zurückwechseln Verfolger neu ansetzen
  }
}

export { CamInput, CameraRig };
