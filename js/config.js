

// ============================== CONFIG ==============================
const CONFIG = {
  physicsHz: 120,                 // feste Physik-Schrittweite (1/120 s)
  maxSubSteps: 8,
  car: {
    name: 'Voltara Aero R',
    mass: 1650,                   // kg
    inertiaBox: { w: 1.9, h: 1.0, l: 4.3 },
    cgHeight: 0.45,               // Schwerpunkt über Boden (Ruhelage, für Modell-Offset)
    cockpitEyeY: 1.2,             // Augenhöhe des Fahrers über Boden
    wheelRadius: 0.34,
    wheelWidth: 0.28,
    wheels: [                     // Aufhängungspunkte relativ zum Schwerpunkt
      { x: -0.84, z: -1.26, front: true  },  // vorne links
      { x:  0.84, z: -1.26, front: true  },  // vorne rechts
      { x: -0.87, z:  1.36, front: false },  // hinten links
      { x:  0.87, z:  1.36, front: false },  // hinten rechts
    ],
    mountY: 0.16,
    suspension: {
      restLength: 0.34,
      springFront: 50000, springRear: 47000,   // N/m (~1,7 Hz Eigenfrequenz)
      damperBump: 3700, damperRebound: 5000,   // Ns/m
      antiRollFront: 26000, antiRollRear: 15000,
      bumpStop: 600000,
      forceApplyLift: 0.18,       // Querkraft etwas über Aufstandspunkt (weniger Wanken)
    },
    tire: {
      mu: 1.75,                   // Haftbeiwert (Hypercar-Semislicks, warm)
      B: 10.5, C: 1.38, E: 0.15,  // vereinfachte Pacejka-Formel
      rollResist: 0.011,
      loadCapFactor: 2.6,         // Max. Radlast (×statisch) für Grip
      handbrakeGrip: 0.62,        // Hinterachs-Seitengrip bei Handbremse
      loadSensitivity: 0.14,      // Grip wächst unterproportional mit Radlast
      rearGrip: 1.10,             // breitere Hinterreifen → stabiler
    },
    // Lenkung: Lenkrad → Vorderräder. Übersetzung = Anschlag / maxRoad (bei 270° ≈ 10,5 : 1).
    // rate/counterRate = maximale Drehgeschwindigkeit des Lenkrads (Hände), omega = Federhärte der Handbewegung.
    steer: { maxRoad: 0.45, falloffFrom: 8, speedFalloff: 0.02, rate: 9.4, counterRate: 12.6, omega: 22, accel: 70, returnRate: 28, returnAccel: 320 },
    aero: { rho: 1.225, CdA: 0.62, ClA: 2.4, frontDownforceShare: 0.42 },
    brake: { maxForce: 28000, frontBias: 0.62, handbrakeForce: 9000 },
    motor: {
      maxTorque: 1000,            // Nm – voller Antritt ab 0 U/min
      maxPower: 620000,           // W (~840 PS)
      redline: 12000,             // U/min
      efficiency: 0.94,
      regenForce: 2400,           // N Rekuperation beim Gas-Wegnehmen
    },
    gearbox: {
      ratios: [2.20, 1.78, 1.47, 1.28, 1.14, 1.02],
      reverse: 2.2,
      finalDrive: 3.6,
      shiftTimeAuto: 0.08, shiftTimeManual: 0.14,
      reverseMaxSpeed: 12,        // m/s
    },
    driveSplitFront: 0.38,        // Allrad, hecklastig verteilt
    tractionControlSlack: 0.97,
    boost: { force: 12500, drain: 1 / 3.4, recharge: 1 / 10, delay: 1.2 },
    flight: { thrust: 9500, climb: 10, landRate: 4.5, yawRate: 1.25, drain: 1 / 28, recharge: 1 / 16, ceiling: 380 },
    stabilityAssist: 14000,       // Nm pro rad/s Gierraten-Abweichung (Fahrhilfe)
  },
};

// ============================== Hilfen ==============================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));   // bildratenunabhängiges Glätten
const approach = (v, t, step) => (v < t ? Math.min(v + step, t) : Math.max(v - step, t));

// ============================== Settings ==============================
const Settings = {
  KEY: 'roadsterEscape.settings.v1',
  data: { transmission: 'auto', tractionControl: true, quality: 'auto', telemetry: false,
          timeOfDay: 'day', weather: 'clear', sound: true, music: true, dynres: true, blurFx: false, filmLook: false, policeLevel: 'normal', steering: 'stick', steerSens: 'mid', tiltInvert: false, haptics: true, camMode: 'chase', camZoom: 1 },
  load() {
    try { Object.assign(this.data, JSON.parse(localStorage.getItem(this.KEY) || '{}')); } catch (e) { /* privat-Modus */ }
    if (this.data.quality === 'auto') {
      // Erstschätzung: alle Touch-Geräte (iPhone UND iPad) starten auf Mittel, nur Rechner auf Hoch.
      // In den ersten Sekunden misst das Spiel die echte Bildrate und stuft bei Bedarf weiter herunter.
      const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
      this.data.quality = touch ? 'medium' : 'high';
      this.data.qualityAuto = true;
    } else if (this.data.qualityAuto === undefined) {
      // Alte Spielstände: früher bekamen iPads automatisch „Hoch“ (Hauptgrund für Ruckeln) → einmalig auf Mittel
      const touch = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
      if (touch && this.data.quality === 'high') this.data.quality = 'medium';
      this.data.qualityAuto = touch;   // auf Rechnern bleibt die gespeicherte Wahl unangetastet
    }
  },
  save() { try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); } catch (e) { /* ignorieren */ } },
};
Settings.load();

const QUALITY = {
  low:    { pixelRatio: 1.25, shadows: false, shadowSize: 0,    antialias: false, physicalPaint: false, headlights: false, bevelSegs: 1,
            treeDensity: 0.15, treeNear: 90,  treeFar: 480,  traffic: 45, parked: 40, pedestrians: 16, rainDrops: 1500, scenery: 500, sceneryRadius: 110, grass: 0,    grassRadius: 0,  particles: 500, lampLights: 0, bloom: false, clouds: false, fogFar: 1150, terrainNear: 180 },
  medium: { pixelRatio: 1.5, shadows: true,  shadowSize: 1024, antialias: true,  physicalPaint: false, headlights: true,  bevelSegs: 2,
            treeDensity: 0.38, treeNear: 150, treeFar: 750,  traffic: 100, parked: 90, pedestrians: 45, rainDrops: 3200, scenery: 1300, sceneryRadius: 160, grass: 6500, grassRadius: 48, particles: 1200, lampLights: 3, bloom: false, clouds: true,  fogFar: 1600, terrainNear: 260 },
  high:   { pixelRatio: 2.0, shadows: true,  shadowSize: 2048, antialias: true,  physicalPaint: true,  headlights: true,  bevelSegs: 3,
            treeDensity: 0.62, treeNear: 230, treeFar: 1100, traffic: 160, parked: 140, pedestrians: 90, rainDrops: 6000, scenery: 2400, sceneryRadius: 220, grass: 13000, grassRadius: 65, particles: 2000, lampLights: 5, bloom: true,  clouds: true,  fogFar: 2200, terrainNear: 340 },
};

export { CONFIG, clamp, lerp, smoothstep, damp, approach, Settings, QUALITY };
