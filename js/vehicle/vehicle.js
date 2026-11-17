import * as THREE from 'three';
import { clamp, smoothstep, damp, approach } from '../config.js';

// ============================== Drivetrain ==============================
/**
 * E-Motor mit Kennlinie: konstantes Maximalmoment bis zur Eckdrehzahl,
 * darüber konstante Leistung (M = P/ω). Simuliertes 6-Gang-Getriebe,
 * damit Handschaltung sinnvoll ist. Automatik schaltet blitzschnell.
 */
class Drivetrain {
  constructor(cfg) {
    this.cfg = cfg;
    this.gear = 1;              // -1 = R, 0 = N, 1..6
    this.rpm = 0;
    this.shiftTimer = 0;
    this.lastShift = -1;
    this.manual = false;
    this.redlineOmega = cfg.motor.redline * Math.PI / 30;
    this.baseOmega = cfg.motor.maxPower / cfg.motor.maxTorque;   // Eckdrehzahl (rad/s)
    this.time = 0;               // simulierte Zeit (unabhängig von der Bildrate)
  }

  get numGears() { return this.cfg.gearbox.ratios.length; }

  ratio(g = this.gear) {
    const gb = this.cfg.gearbox;
    if (g === 0) return 0;
    if (g < 0) return -gb.reverse * gb.finalDrive;
    return gb.ratios[g - 1] * gb.finalDrive;
  }

  /** Motormoment bei Winkelgeschwindigkeit ω (rad/s) und Vollgas. */
  torqueAt(omega) {
    const m = this.cfg.motor;
    const w = Math.abs(omega);
    if (w >= this.redlineOmega) return 0;
    const t = w < this.baseOmega ? m.maxTorque : m.maxPower / w;
    // weiches Abregeln in den letzten 3 %
    return t * (1 - smoothstep(this.redlineOmega * 0.97, this.redlineOmega, w));
  }

  shift(dir) {
    const now = this.time;
    const target = clamp(this.gear + dir, -1, this.numGears);
    if (target === this.gear) return false;
    // Schutz vor Überdrehen beim Runterschalten (manuell)
    if (target > 0 && dir < 0) {
      const newRpm = this.wheelOmega * this.ratio(target) * 30 / Math.PI;
      if (newRpm > this.cfg.motor.redline * 1.02) return false;
    }
    this.gear = target;
    this.shiftTimer = this.manual ? this.cfg.gearbox.shiftTimeManual : this.cfg.gearbox.shiftTimeAuto;
    this.lastShift = now;
    return true;
  }

  /** Automatik-Logik: schaltet nach Drehzahl, mit Hysterese. */
  autoShift(throttle) {
    if (this.gear < 1 || this.shiftTimer > 0) return;
    if (this.time - this.lastShift < 0.35) return;
    const rl = this.cfg.motor.redline;
    const up = throttle > 0.5 ? rl * 0.93 : rl * 0.62;
    if (this.rpm > up && this.gear < this.numGears) { this.shift(1); return; }
    if (this.gear > 1) {
      const lowerRpm = this.wheelOmega * this.ratio(this.gear - 1) * 30 / Math.PI;
      const down = throttle > 0.5 ? rl * 0.80 : rl * 0.45;
      if (lowerRpm < down) this.shift(-1);
    }
  }

  /**
   * @param wheelOmega mittlere Drehzahl der angetriebenen Räder (rad/s, vorwärts positiv)
   * @returns gesamtes Antriebsmoment an den Rädern (Nm, Vorzeichen = Fahrtrichtung)
   */
  update(dt, wheelOmega, throttle, grounded = true) {
    this.wheelOmega = wheelOmega;
    this.time += dt;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    const r = this.ratio();
    const motorOmega = Math.abs(wheelOmega * r);
    this.rpm = damp(this.rpm, motorOmega * 30 / Math.PI, 25, dt);
    if (!this.manual && grounded) this.autoShift(throttle);
    if (r === 0 || this.shiftTimer > 0 || throttle <= 0) return 0;
    const tq = this.torqueAt(motorOmega) * throttle;
    return tq * r * this.cfg.motor.efficiency;
  }

  label() {
    if (this.gear < 0) return ['R', ''];
    if (this.gear === 0) return ['N', ''];
    return this.manual ? [String(this.gear), ''] : ['D', String(this.gear)];
  }
}

// ============================== Vehicle (Physik) ==============================
/** Vereinfachte Pacejka-„Magic Formula“: normierte Kraft (−1..1) aus Schlupf. */
function magic(slip, B, C, E) {
  const Bx = B * slip;
  return Math.sin(C * Math.atan(Bx - E * (Bx - Math.atan(Bx))));
}

/**
 * Raycast-Fahrzeug: Starrkörper (6 Freiheitsgrade) + 4 Strahlen nach unten.
 * Pro Rad: Feder/Dämpfer → Radlast → Reifenkräfte (längs/quer) mit
 * Reibungskreis. Gewichtsverlagerung entsteht physikalisch dadurch, dass die
 * Kräfte am Aufstandspunkt unter dem Schwerpunkt angreifen.
 */
class Vehicle {
  constructor(world, cfg) {
    this.world = world; this.cfg = cfg;
    this.mass = cfg.mass; this.invMass = 1 / cfg.mass;
    const { w, h, l } = cfg.inertiaBox, m = cfg.mass;
    // Trägheitsmomente (Quader), Hauptachsen im Fahrzeug-System
    this.invInertia = new THREE.Vector3(
      1 / (m / 12 * (h * h + l * l)),   // Nicken (x)
      1 / (m / 12 * (w * w + l * l)),   // Gieren (y)
      1 / (m / 12 * (w * w + h * h) * 1.15)); // Rollen (z)

    this.pos = new THREE.Vector3(); this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3(); this.angVel = new THREE.Vector3();
    this.prevPos = new THREE.Vector3(); this.prevQuat = new THREE.Quaternion();

    const s = cfg.suspension;
    this.wheels = cfg.wheels.map((wd) => ({
      local: new THREE.Vector3(wd.x, cfg.mountY, wd.z),
      front: wd.front, left: wd.x < 0,
      k: wd.front ? s.springFront : s.springRear,
      suspLen: s.restLength, compression: 0, prevCompression: 0,
      grounded: false, load: 0, grip: 1, roll: 1, contact: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
      omega: 0, spin: 0, steer: 0, slipAngle: 0, slipRatio: 0, sliding: false, slideAmount: 0,
      fLong: 0, fLat: 0, vLong: 0, vLat: 0,
    }));
    this.staticLoad = cfg.mass * 9.81 / 4;

    this.drivetrain = new Drivetrain(cfg);
    this.steerAngle = 0;
    this.throttle = 0; this.brake = 0; this.handbrake = false;
    this.direction = 1;          // Automatik: 1 = vorwärts (D), −1 = rückwärts (R)
    this.dirTimer = 0;
    this.tractionControl = true;
    this.speed = 0; this.forwardSpeed = 0;
    this.braking = false; this.reversing = false;
    this.latAccel = 0; this.longAccel = 0;
    this.airTime = 0; this.groundedCount = 0;
    this.lastImpact = 0;
    this.upsideDownTime = 0;   // für automatisches Aufrichten
    this.boostEnergy = 1; this.boostCool = 0; this.boosting = false; this.boostIn = false;
    this.flyEnergy = 1; this.flying = false; this.landing = false; this.altitude = 0;
    this.steerIn = 0; this.climbIn = 0; this.inWater = 0;

    // Wiederverwendbare Vektoren (keine Allokationen pro Schritt)
    this._v = Array.from({ length: 12 }, () => new THREE.Vector3());
    this._qInv = new THREE.Quaternion(); this._q = new THREE.Quaternion();
    this.force = new THREE.Vector3(); this.torque = new THREE.Vector3();
    this.reset(new THREE.Vector3(0, 0, 150), 0);
  }

  reset(p, yaw) {
    const h = this.world.sample(p.x, p.z);
    this.pos.set(p.x, h + this.cfg.cgHeight + 0.15, p.z);
    this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat);
    this.drivetrain.gear = 1; this.direction = 1; this.steerAngle = 0;
    this.flying = false; this.landing = false; this.altitude = 0; this.airTime = 0;
    for (const w of this.wheels) { w.omega = 0; w.compression = w.prevCompression = 0; }
  }

  /** Kraft F (Welt) am Weltpunkt p anwenden. */
  addForceAt(F, p) {
    this.force.add(F);
    const r = this._v[11].subVectors(p, this.pos);
    this.torque.add(r.cross(F));
  }

  /** Winkelbeschleunigung aus Drehmoment (Welt): Iw⁻¹·τ = R·I⁻¹·Rᵀ·τ */
  applyInvInertia(vecWorld) {
    this._qInv.copy(this.quat).invert();
    vecWorld.applyQuaternion(this._qInv);
    vecWorld.x *= this.invInertia.x; vecWorld.y *= this.invInertia.y; vecWorld.z *= this.invInertia.z;
    return vecWorld.applyQuaternion(this.quat);
  }

  /** Eingaben in Gas/Bremse/Richtung übersetzen (Automatik inkl. Rückwärtsgang). */
  processInput(inp, dt) {
    const dtn = this.drivetrain;
    const fs = this.forwardSpeed;
    let throttle = 0, brake = 0;
    if (dtn.manual) {
      throttle = inp.throttle; brake = inp.brake;
    } else {
      if (this.direction === 1) {
        throttle = inp.throttle; brake = inp.brake;
        // Stillstand + Bremse halten → Rückwärtsgang
        if (inp.brake > 0.1 && inp.throttle < 0.1 && fs < 0.6) { this.dirTimer += dt; if (this.dirTimer > 0.22) { this.direction = -1; dtn.gear = -1; this.dirTimer = 0; } }
        else this.dirTimer = 0;
      } else {
        throttle = inp.brake; brake = inp.throttle;   // rückwärts: „Bremse“ = Gas
        if (inp.throttle > 0.1 && fs > -0.6) { this.dirTimer += dt; if (this.dirTimer > 0.12) { this.direction = 1; dtn.gear = 1; this.dirTimer = 0; } }
        else this.dirTimer = 0;
        if (fs < -this.cfg.gearbox.reverseMaxSpeed) throttle = 0;
      }
    }
    // E-Motor reagiert schnell, aber nicht digital hart
    this.throttle = approach(this.throttle, throttle, dt * 7);
    this.brake = approach(this.brake, brake, dt * 9);
    this.handbrake = inp.handbrake;
    this.boostIn = inp.boost; this.steerIn = inp.steer; this.climbIn = inp.climb || 0;
    this.braking = this.brake > 0.05;
    this.reversing = dtn.gear < 0;

    // Geschwindigkeitsabhängige Lenkung
    const sc = this.cfg.steer;
    let maxSteer = sc.max / (1 + Math.abs(fs) * sc.speedFalloff);
    // Im Drift mehr Lenkeinschlag zulassen (Gegenlenken bis zum Schwimmwinkel)
    const lat = this.vel.dot(this._v[2].set(1, 0, 0).applyQuaternion(this.quat));
    const beta = Math.abs(Math.atan2(lat, Math.max(Math.abs(fs), 1)));
    // nur in Gegenlenk-Richtung (zur Bewegungsrichtung hin): lat > 0 = rutscht nach rechts → rechts lenken (steer < 0)
    const counter = inp.steer !== 0 && Math.sign(inp.steer) === -Math.sign(lat);
    if (this.speed > 4 && counter) maxSteer = Math.max(maxSteer, Math.min(beta + 0.08, sc.max));
    const target = inp.steer * maxSteer;
    const returning = Math.abs(target) < Math.abs(this.steerAngle) || Math.sign(target) !== Math.sign(this.steerAngle);
    this.steerAngle = approach(this.steerAngle, target, (returning ? sc.returnRate : sc.rate) * dt * (0.35 + maxSteer / sc.max * 0.65));
  }

  step(dt) {
    const cfg = this.cfg, S = cfg.suspension, T = cfg.tire, world = this.world;
    const v = this._v;
    this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat);
    this.force.set(0, 0, 0); this.torque.set(0, 0, 0);
    // Boost-Energie: leert sich beim Boosten, lädt nach kurzer Pause langsam nach
    const B = cfg.boost;
    this.boosting = this.boostIn && this.boostEnergy > 0.01;
    if (this.boosting) { this.boostEnergy = Math.max(0, this.boostEnergy - dt * B.drain); this.boostCool = B.delay; }
    else if ((this.boostCool -= dt) <= 0) this.boostEnergy = Math.min(1, this.boostEnergy + dt * B.recharge);
    if (this.flying) { this.stepFlight(dt); return; }
    if (this.groundedCount > 0) this.flyEnergy = Math.min(1, this.flyEnergy + dt * cfg.flight.recharge);
    this.altitude = 0;

    const up = v[0].set(0, 1, 0).applyQuaternion(this.quat);
    const fwdBody = v[1].set(0, 0, -1).applyQuaternion(this.quat);
    const rightBody = v[2].set(1, 0, 0).applyQuaternion(this.quat);
    this.forwardSpeed = this.vel.dot(fwdBody);
    this.speed = this.vel.length();

    // ---------- Antrieb ----------
    let driveOmega = 0, nDriven = 0;
    for (const w of this.wheels) { driveOmega += w.omega; nDriven++; }
    driveOmega /= nDriven;
    const dt_ = this.drivetrain;
    const wheelTorqueTotal = dt_.update(dt, driveOmega, this.throttle, this.groundedCount > 0);
    const driveForceTotal = wheelTorqueTotal / cfg.wheelRadius;
    // Rekuperation (nur Automatik/D, Gas los, rollend)
    let regen = 0;
    if (this.throttle < 0.05 && Math.abs(this.forwardSpeed) > 1 && !this.braking) regen = cfg.motor.regenForce * clamp(Math.abs(this.forwardSpeed) / 8, 0, 1);

    // ---------- Räder ----------
    const down = v[3].copy(up).negate();
    const maxLen = S.restLength + cfg.wheelRadius;
    let grounded = 0;
    const massShare = this.mass / 4;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const mount = v[4].copy(w.local).applyQuaternion(this.quat).add(this.pos);

      // --- Raycast gegen Höhenfeld (Fixpunkt-Iteration) ---
      let hit = false, t = maxLen;
      if (down.y < -0.25) {
        let h = world.sample(mount.x, mount.z, undefined, mount.y);
        t = (mount.y - h) / -down.y;
        for (let it = 0; it < 2; it++) {
          h = world.sample(mount.x + down.x * t, mount.z + down.z * t, undefined, mount.y);
          t = (mount.y - h) / -down.y;
        }
        if (t <= maxLen) {
          hit = true;
          w.contact.copy(down).multiplyScalar(t).add(mount);
          world.sample(w.contact.x, w.contact.z, w.normal, mount.y);
          w.grip = world.grip(w.contact.x, w.contact.z); w.roll = world.roll(w.contact.x, w.contact.z);
        }
      }

      // Lenkwinkel (leichtes Ackermann: kurveninneres Rad stärker)
      if (w.front) {
        const inner = (this.steerAngle > 0) === w.left;
        w.steer = this.steerAngle * (inner ? 1.08 : 0.94);
      } else w.steer = 0;

      w.prevCompression = w.compression;
      if (!hit) {
        w.grounded = false; w.compression = 0; w.suspLen = S.restLength; w.load = 0;
        w.sliding = false; w.slideAmount = 0; w.fLong = w.fLat = 0;
        continue;
      }
      grounded++;
      w.grounded = true;
      w.suspLen = Math.max(t - cfg.wheelRadius, 0);
      w.compression = S.restLength - w.suspLen;
    }

    // --- Federkräfte inkl. Stabilisatoren ---
    const arF = (this.wheels[0].compression - this.wheels[1].compression) * S.antiRollFront;
    const arR = (this.wheels[2].compression - this.wheels[3].compression) * S.antiRollRear;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) continue;
      const compVel = (w.compression - w.prevCompression) / dt;
      const c = compVel > 0 ? S.damperBump : S.damperRebound;
      let Fs = w.k * w.compression + c * compVel;
      if (w.suspLen < 0.03) Fs += S.bumpStop * (0.03 - w.suspLen);   // Anschlagpuffer
      const ar = i < 2 ? (i === 0 ? arF : -arF) : (i === 2 ? arR : -arR);
      if (this.wheels[i ^ 1].grounded) Fs += ar;
      Fs = Math.max(0, Fs);
      w.load = Fs;
      const Fsusp = v[5].copy(up).multiplyScalar(Fs);
      this.addForceAt(Fsusp, w.contact);
    }

    // --- Reifenkräfte ---
    let latSum = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) {
        // Rad in der Luft: dreht durch Antrieb hoch, sonst langsam aus
        const driveShare = w.front ? cfg.driveSplitFront / 2 : (1 - cfg.driveSplitFront) / 2;
        w.omega += (driveForceTotal * driveShare * cfg.wheelRadius / 2.2) * dt;
        w.omega *= (this.brake > 0.1 || (this.handbrake && !w.front)) ? 0.8 : 0.995;
        w.omega = clamp(w.omega, -dt_.redlineOmega / 3, dt_.redlineOmega / 3);
        continue;
      }
      const n = w.normal;
      const Fz = Math.min(w.load, this.staticLoad * T.loadCapFactor);

      // Radrichtung (gelenkt) auf Fahrbahnebene projiziert
      const fwd = v[6].set(-Math.sin(w.steer), 0, -Math.cos(w.steer)).applyQuaternion(this.quat);
      fwd.addScaledVector(n, -fwd.dot(n)).normalize();
      const side = v[7].crossVectors(fwd, n);           // zeigt nach rechts

      // Geschwindigkeit des Aufstandspunkts
      const r = v[8].subVectors(w.contact, this.pos);
      const pv = v[9].crossVectors(this.angVel, r).add(this.vel);
      const vLong = pv.dot(fwd), vLat = pv.dot(side);
      w.vLong = vLong; w.vLat = vLat;

      // Querkraft aus Schräglaufwinkel
      const slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 0.5));
      w.slipAngle = slipAngle;
      // Lastempfindlichkeit: doppelte Last ≠ doppelter Grip (macht Stabi-Abstimmung wirksam)
      // Untergrund (Asphalt/Gras/Sand …) bestimmt den Grip
      let mu = T.mu * w.grip * (w.front ? 1 : T.rearGrip) * clamp(1 - T.loadSensitivity * (Fz / this.staticLoad - 1), 0.6, 1.15);
      const handbrakeRear = this.handbrake && !w.front;
      let latMu = handbrakeRear ? mu * T.handbrakeGrip : mu;
      let Flat = -magic(slipAngle, T.B, T.C, T.E) * latMu * Fz;
      // Bei kleinem Tempo: nicht über das Ziel hinausschießen (kein Zittern im Stand)
      const maxLatStop = Math.abs(vLat) * massShare / dt;
      Flat = clamp(Flat, -maxLatStop, maxLatStop);

      // Längskraft: Antrieb, Bremse, Rekuperation, Rollwiderstand
      const driveShare = w.front ? cfg.driveSplitFront / 2 : (1 - cfg.driveSplitFront) / 2;
      let Fdrive = driveForceTotal * driveShare;
      const brakeShare = w.front ? cfg.brake.frontBias / 2 : (1 - cfg.brake.frontBias) / 2;
      let Fbrake = this.brake * cfg.brake.maxForce * brakeShare + regen * driveShare;
      if (handbrakeRear) Fbrake += cfg.brake.handbrakeForce / 2;
      Fbrake += T.rollResist * w.roll * Fz;
      const maxBrakeStop = Math.abs(vLong) * massShare / dt;  // nicht rückwärts „bremsen“
      // ABS: Betriebsbremse nie über den verfügbaren Grip (Handbremse darf blockieren)
      if (!handbrakeRear) Fbrake = Math.min(Fbrake, mu * Fz * 0.97);
      const FbrakeApplied = Math.min(Fbrake, maxBrakeStop) * -Math.sign(vLong);
      const brakeLocked = Fbrake > mu * Fz * 1.05 && Math.abs(vLong) > 1;

      // Traktionskontrolle: Antrieb auf verfügbaren Längsgrip begrenzen
      const maxF = mu * Fz;
      if (this.tractionControl && Fdrive !== 0) {
        let availLong = Math.sqrt(Math.max(maxF * maxF - Flat * Flat, 0)) * cfg.tractionControlSlack;
        // Hinterachse über dem Grip-Maximum → Moment zurücknehmen (verhindert Dreher)
        if (!w.front && Math.abs(slipAngle) > 0.16 && Math.abs(vLong) > 3) availLong *= 0.35;
        Fdrive = clamp(Fdrive, -availLong, availLong);
      }
      let Flong = Fdrive + FbrakeApplied;

      // Reibungskreis: Längs + Quer zusammen begrenzt
      const total = Math.hypot(Flong, Flat);
      const demandLong = Math.abs(Fdrive + FbrakeApplied);
      w.sliding = false; w.slideAmount = 0;
      if (total > maxF && total > 1) {
        const s = maxF / total;
        // Rutscht der Reifen, sinkt der Grip leicht (Gleitreibung < Haftreibung)
        const slideGrip = 0.92;
        Flong *= s * slideGrip; Flat *= s * slideGrip;
        w.sliding = true;
        w.slideAmount = clamp((total - maxF) / maxF, 0, 1);
      }
      if (Math.abs(slipAngle) > 0.22 && Math.abs(vLat) > 2) { w.sliding = true; w.slideAmount = Math.max(w.slideAmount, clamp((Math.abs(slipAngle) - 0.2) * 2, 0, 1)); }
      w.fLong = Flong; w.fLat = Flat;
      latSum += Flat;

      // Kraft anwenden (Querkraft leicht angehoben → weniger Wankmoment)
      const F = v[10].copy(fwd).multiplyScalar(Flong).addScaledVector(side, Flat);
      const applyAt = v[8].copy(w.contact).addScaledVector(up, S.forceApplyLift);
      this.addForceAt(F, applyAt);

      // Raddrehung (für Optik und Motordrehzahl)
      const rollOmega = vLong / cfg.wheelRadius;
      let targetOmega = rollOmega;
      if (brakeLocked || (handbrakeRear && Math.abs(vLong) > 0.5)) targetOmega = 0;
      else if (Fdrive !== 0 && Math.abs(Fdrive) > maxF * 0.98) {
        const excess = (Math.abs(Fdrive) - maxF) / maxF;     // durchdrehende Räder
        targetOmega = rollOmega + Math.sign(Fdrive) * (3 + excess * 40);
      }
      w.omega = damp(w.omega, targetOmega, 30, dt);
      w.slipRatio = (w.omega * cfg.wheelRadius - vLong) / Math.max(Math.abs(vLong), 1);
      if (Math.abs(w.slipRatio) > 0.25) { w.sliding = true; w.slideAmount = Math.max(w.slideAmount, clamp(Math.abs(w.slipRatio) - 0.2, 0, 1)); }
    }

    // ---------- Aerodynamik & Schwerkraft ----------
    const A = cfg.aero;
    const sp = this.speed;
    if (sp > 0.1) {
      const drag = v[5].copy(this.vel).multiplyScalar(-0.5 * A.rho * A.CdA * sp);
      this.force.add(drag);
      // Abtrieb, nur wenn Räder am Boden (sonst „saugt“ er das Auto im Sprung nach unten)
      if (grounded > 0) {
        const df = 0.5 * A.rho * A.ClA * this.forwardSpeed * this.forwardSpeed;
        const pF = v[6].set(0, 0, -1.3).applyQuaternion(this.quat).add(this.pos);
        const pR = v[7].set(0, 0, 1.3).applyQuaternion(this.quat).add(this.pos);
        this.addForceAt(v[9].copy(up).multiplyScalar(-df * A.frontDownforceShare), pF);
        this.addForceAt(v[9].copy(up).multiplyScalar(-df * (1 - A.frontDownforceShare)), pR);
      }
    }
    this.force.y -= 9.81 * this.mass;
    // Boost: Schub im Schwerpunkt (wirkt auch in der Luft, z. B. bei Sprüngen)
    if (this.boosting) this.force.addScaledVector(fwdBody, B.force);

    // Fahrhilfe (ESP-ähnlich): dämpft ungewolltes Eindrehen, Driften bleibt möglich
    if (this.tractionControl && grounded >= 3 && this.speed > 3 && !this.handbrake) {
      const L = 2.62;
      // Wunsch-Gierrate aus Lenkwinkel, aber begrenzt auf das, was der Grip hergibt (a_quer = v·ω ≤ μ·g)
      const gripLimit = (cfg.tire.mu * 9.81 * 1.0) / Math.max(Math.abs(this.forwardSpeed), 1);
      const desired = clamp(this.forwardSpeed * Math.tan(this.steerAngle) / L, -gripLimit, gripLimit);
      const yawRate = this.angVel.dot(up);
      const err = yawRate - desired;
      const dead = 0.03;
      if (Math.abs(err) > dead) this.torque.addScaledVector(up, -(err - Math.sign(err) * dead) * cfg.stabilityAssist);
    }

    // Hilfe in der Luft: Auto richtet sich sanft waagerecht aus (bessere Landungen)
    if (grounded === 0) {
      this.airTime += dt;
      const level = v[5].crossVectors(up, v[6].set(0, 1, 0));
      this.torque.addScaledVector(level, 2600);
      this.torque.addScaledVector(this.angVel, -300);
    } else {
      // Harte Landung → Kamera wackelt, Haptik
      if (this.airTime > 0.3) this.lastImpact = Math.max(this.lastImpact, Math.abs(this.vel.y) * 0.8 + this.airTime);
      this.airTime = 0;
    }
    this.groundedCount = grounded;

    // ---------- Integration (semi-implizit) ----------
    const prevVel = v[10].copy(this.vel);
    this.vel.addScaledVector(this.force, this.invMass * dt);
    const angAcc = this.applyInvInertia(v[5].copy(this.torque));
    this.angVel.addScaledVector(angAcc, dt);
    this.angVel.multiplyScalar(1 - 0.08 * dt);      // minimale Luft-/Lagerdämpfung
    this.pos.addScaledVector(this.vel, dt);
    const av = this.angVel;
    this._q.set(av.x * dt * 0.5, av.y * dt * 0.5, av.z * dt * 0.5, 0).multiply(this.quat);
    this.quat.x += this._q.x; this.quat.y += this._q.y; this.quat.z += this._q.z; this.quat.w += this._q.w;
    this.quat.normalize();

    // Beschleunigung in g (für Telemetrie/Kamera)
    const acc = prevVel.subVectors(this.vel, prevVel).divideScalar(dt);
    this.longAccel = damp(this.longAccel, acc.dot(fwdBody) / 9.81, 10, dt);
    this.latAccel = damp(this.latAccel, acc.dot(rightBody) / 9.81, 10, dt);

    this.collideChassis(dt);
    this.world.collideVehicle?.(this);
    this.applyWater(dt);
    this.enforceBounds();

    // Auf dem Dach/der Seite liegen geblieben → nach 2,5 s automatisch aufrichten
    if (up.y < 0.35 && this.speed < 3) this.upsideDownTime += dt; else this.upsideDownTime = 0;
    if (this.upsideDownTime > 2.5) { this.reset(this.pos.clone(), this.yaw()); this.upsideDownTime = 0; }
  }

  /** Abheben bzw. Landeanflug einleiten. */
  toggleFly() {
    if (!this.flying) {
      if (this.flyEnergy < 0.12) return 'empty';
      this.flying = true; this.landing = false;
      this.vel.y = Math.max(this.vel.y, 3);
      return 'up';
    }
    this.landing = true;
    return 'land';
  }

  /**
   * Flugphysik: Hubdüsen regeln die Steig-/Sinkrate (Joystick ↕), Schub nach vorn
   * mit Gas, Lenken dreht (gieren) und neigt das Auto in die Kurve. Die Lage wird
   * geregelt, damit es sich gutmütig fliegt. Energie begrenzt; nahe am Boden
   * wird das Sinken automatisch abgebremst → sanfte Landung.
   */
  stepFlight(dt) {
    const cfg = this.cfg, F = cfg.flight, v = this._v;
    const up = v[0].set(0, 1, 0).applyQuaternion(this.quat);
    const fwd = v[1].set(0, 0, -1).applyQuaternion(this.quat);
    const right = v[2].set(1, 0, 0).applyQuaternion(this.quat);
    this.forwardSpeed = this.vel.dot(fwd); this.speed = this.vel.length();
    for (const w of this.wheels) { w.grounded = false; w.load = 0; w.sliding = false; w.slideAmount = 0; w.omega *= 0.985; w.compression = w.prevCompression = 0; w.suspLen = cfg.suspension.restLength; }
    this.groundedCount = 0; this.airTime += dt;
    const ground = this.world.sample(this.pos.x, this.pos.z, undefined, this.pos.y);
    const alt = this.pos.y - cfg.cgHeight - Math.max(ground, this.world.waterLevel);
    this.altitude = alt;
    if (!this.landing) { this.flyEnergy -= dt * F.drain; if (this.flyEnergy <= 0) { this.flyEnergy = 0; this.landing = true; } }
    // Steigrate
    let climb = this.landing ? -F.landRate : this.climbIn * F.climb;
    if (this.pos.y > F.ceiling) climb = Math.min(climb, 0);
    if (climb < 0) climb = Math.max(climb, -(0.7 + Math.max(alt, 0) * 0.55));
    const vy = this.vel.y;
    this.force.y += this.mass * clamp((climb - vy) * 2.3, -7, 9);
    // Vortrieb in Blickrichtung (waagrecht)
    const fh = v[3].set(fwd.x, 0, fwd.z); fh.multiplyScalar(1 / (fh.length() || 1));
    const rh = v[4].set(-fh.z, 0, fh.x);
    let thrust = this.throttle * F.thrust - this.brake * F.thrust * 0.8;
    if (this.boosting) thrust += cfg.boost.force * 1.3;
    this.force.addScaledVector(fh, thrust);
    // Seitliche Führung + Luftwiderstand
    this.force.addScaledVector(rh, -this.vel.dot(rh) * this.mass * 1.6);
    const A = cfg.aero;
    this.force.addScaledVector(this.vel, -0.5 * A.rho * A.CdA * 1.3 * this.speed - this.mass * 0.05);
    // Lageregelung
    const Ix = 1 / this.invInertia.x, Iy = 1 / this.invInertia.y, Iz = 1 / this.invInertia.z;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const yawT = this.steerIn * F.yawRate * (0.55 + 0.45 * Math.min(1, hs / 12));
    this.torque.y += Iy * 5 * (yawT - this.angVel.y);
    const pitch = Math.asin(clamp(fwd.y, -1, 1)), tp = clamp(vy / 18, -0.3, 0.3) - this.throttle * 0.05 + this.brake * 0.06;
    this.torque.addScaledVector(right, Ix * (7 * (tp - pitch) - 3.5 * this.angVel.dot(right)));
    const roll = -Math.asin(clamp(right.y, -1, 1)), tr = -this.steerIn * 0.42 * Math.min(1, hs / 15);
    this.torque.addScaledVector(fwd, Iz * (7 * (tr - roll) - 3.5 * this.angVel.dot(fwd)));
    // Integration (Hubdüsen heben die Schwerkraft auf → keine Gewichtskraft addieren)
    const prevVel = v[10].copy(this.vel);
    this.vel.addScaledVector(this.force, this.invMass * dt);
    this.angVel.addScaledVector(this.applyInvInertia(v[5].copy(this.torque)), dt);
    this.pos.addScaledVector(this.vel, dt);
    const av = this.angVel;
    this._q.set(av.x * dt * 0.5, av.y * dt * 0.5, av.z * dt * 0.5, 0).multiply(this.quat);
    this.quat.x += this._q.x; this.quat.y += this._q.y; this.quat.z += this._q.z; this.quat.w += this._q.w;
    this.quat.normalize();
    const acc = prevVel.subVectors(this.vel, prevVel).divideScalar(dt);
    this.longAccel = damp(this.longAccel, acc.dot(fwd) / 9.81, 10, dt);
    this.latAccel = damp(this.latAccel, acc.dot(right) / 9.81, 10, dt);
    this.collideChassis(dt);
    this.world.collideVehicle?.(this);
    this.applyWater(dt);
    this.enforceBounds();
    // Aufsetzen
    if (this.landing && alt < 0.15) { this.flying = false; this.landing = false; this.airTime = 0; }
  }

  /** Fahrtrichtung (Gierwinkel) – 0 = Richtung −Z. */
  yaw() {
    const f = this._v[11].set(0, 0, -1).applyQuaternion(this.quat);
    return Math.atan2(-f.x, -f.z);
  }

  /** Karosserie-Eckpunkte gegen Boden: Impuls + Reibung (Überschlag, harte Landungen). */
  collideChassis(dt) {
    if (!this._hull) {
      const pts = [];
      for (const x of [-0.92, 0.92]) for (const y of [-0.27, 0.42]) for (const z of [-2.15, 2.15]) pts.push(new THREE.Vector3(x, y, z));
      pts.push(new THREE.Vector3(0, 0.68, 0.1), new THREE.Vector3(-0.92, 0.1, 0), new THREE.Vector3(0.92, 0.1, 0), new THREE.Vector3(0, -0.27, 0));
      this._hull = pts;
    }
    const v = this._v, n = v[6];
    let maxImpact = 0;
    for (const lp of this._hull) {
      const p = v[4].copy(lp).applyQuaternion(this.quat).add(this.pos);
      const h = this.world.sample(p.x, p.z, n, p.y);
      const depth = h - p.y;
      if (depth <= 0) continue;
      const r = v[5].subVectors(p, this.pos);
      const pv = v[7].crossVectors(this.angVel, r).add(this.vel);
      const vn = pv.dot(n);
      // Positionskorrektur
      this.pos.addScaledVector(n, depth * 0.6);
      if (vn >= 0) continue;
      // Effektive Masse entlang der Normale
      const rn = v[8].crossVectors(r, n);
      const k = this.invMass + this.applyInvInertia(v[9].copy(rn)).cross(r).dot(n);
      const jn = -(1 + 0.15) * vn / k;
      const J = v[9].copy(n).multiplyScalar(jn);
      // Reibung (Coulomb)
      const vt = v[10].copy(pv).addScaledVector(n, -vn);
      const vtl = vt.length();
      if (vtl > 1e-3) {
        const jt = Math.min(vtl / k, 0.55 * jn);
        J.addScaledVector(vt, -jt / vtl);
      }
      this.vel.addScaledVector(J, this.invMass);
      this.angVel.add(this.applyInvInertia(v[11].crossVectors(r, J)));
      maxImpact = Math.max(maxImpact, -vn);
    }
    if (maxImpact > 3) this.lastImpact = maxImpact;
  }

  /** Wasser: starker Widerstand, etwas Auftrieb. Das Spiel setzt das Auto nach kurzer Zeit zurück. */
  applyWater(dt) {
    this.inWater = 0;
    const wl = this.world.waterLevel;
    if (wl === undefined || this.pos.y > wl + 0.8) return;
    if (this.world.sample(this.pos.x, this.pos.z) >= wl - 0.05) return;
    const sub = clamp((wl - (this.pos.y - 0.45)) / 1.1, 0, 1);
    if (sub <= 0) return;
    this.inWater = sub;
    this.vel.multiplyScalar(Math.exp(-dt * 2.4 * sub));
    this.vel.y += 9.81 * 0.55 * sub * dt;
    this.angVel.multiplyScalar(Math.exp(-dt * 2 * sub));
  }

  /** Unsichtbare Weltgrenze: weich zurückschieben, nie herausfallen. */
  enforceBounds() {
    const b = this.world.bound;
    for (const ax of ['x', 'z']) {
      if (Math.abs(this.pos[ax]) > b) {
        const s = Math.sign(this.pos[ax]);
        this.pos[ax] = s * b;
        if (this.vel[ax] * s > 0) this.vel[ax] *= -0.3;
      }
    }
    // Sicherheitsnetz: niemals unter das Gelände
    const h = this.world.sample(this.pos.x, this.pos.z);
    if (this.pos.y < h - 1.5) { this.pos.y = h + 1.5; this.vel.y = Math.max(this.vel.y, 0); }
  }
}

export { Drivetrain, magic, Vehicle };
