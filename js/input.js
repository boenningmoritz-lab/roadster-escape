import { clamp, Settings } from './config.js';

// ============================== Haptics ==============================
/**
 * Haptisches Feedback. Android: navigator.vibrate. iOS Safari (ab iOS 18)
 * kennt kein vibrate, löst aber beim Umschalten eines <input switch> einen
 * kurzen Haptik-Impuls aus – das nutzen wir über ein unsichtbares Label.
 */
const Haptics = {
  last: 0, label: null,
  init() {
    if (navigator.vibrate) return;
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:-200px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.setAttribute('switch', ''); inp.tabIndex = -1;
    label.appendChild(inp); document.body.appendChild(label);
    this.label = label;
  },
  pulse(ms = 10) {
    if (!Settings.data.haptics) return;
    const now = performance.now();
    if (now - this.last < 60) return;
    this.last = now;
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
      else this.label?.click();
    } catch (e) { /* nicht unterstützt */ }
  },
};

// ============================== Input ==============================
/**
 * Sammelt alle Eingaben in einem Zustand:
 *  - Tastatur (Testen am Rechner)
 *  - schwebender Joystick links (erscheint dort, wo der Daumen aufsetzt)
 *  - Neigungssteuerung (DeviceOrientation, in den Einstellungen wählbar)
 *  - Knöpfe rechts; jeder Finger ist ein eigener Pointer → echtes Multitouch
 */
const Input = {
  keys: new Set(),
  pressed: new Set(),           // einmalige Ereignisse (Gangwechsel …)
  btn: { gas: false, brake: false, hand: false, boost: false, fly: false },
  stick: { id: null, x: 0, y: 0, cx: 0, cy: 0, radius: 58 },
  tilt: { listening: false, raw: 0, zero: null, last: 0 },
  scale: 1,
  state: { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, fly: false, stickX: 0, stickY: 0 },

  init() {
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });

    const bind = (id, key, onPress) => {
      const el = document.getElementById(id);
      const active = new Set();
      const set = () => { this.btn[key] = active.size > 0; el.classList.toggle('on', active.size > 0); };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); active.add(e.pointerId);
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* nicht kritisch */ }
        set(); if (onPress) onPress(); Haptics.pulse(8);
      });
      const up = (e) => { active.delete(e.pointerId); set(); };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('lostpointercapture', up);
      this._buttons = this._buttons || [];
      this._buttons.push(() => { active.clear(); set(); });
    };
    bind('tGas', 'gas'); bind('tBrake', 'brake'); bind('tHand', 'hand');
    bind('tBoost', 'boost'); bind('tFly', 'fly', () => this.pressed.add('Fly'));
    bind('tUp', 'up', () => this.pressed.add('GearUp'));
    bind('tDown', 'down', () => this.pressed.add('GearDown'));
    this.bindStick();

    // Browser-Gesten unterbinden: Scrollen, Pinch-Zoom, Doppeltipp, Kontextmenü, Markieren
    const stop = (e) => e.preventDefault();
    document.addEventListener('touchmove', stop, { passive: false });
    document.addEventListener('touchstart', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
    document.addEventListener('contextmenu', stop);
    document.addEventListener('gesturestart', stop);
    document.addEventListener('gesturechange', stop);
    document.addEventListener('dblclick', stop);
    document.addEventListener('selectstart', stop);
    this.layout();
  },

  releaseAll() {
    this.keys.clear();
    this._buttons?.forEach((f) => f());
    this.endStick();
  },

  /** Skalierung und Ruheposition des Joysticks an Bildschirmgröße anpassen. */
  layout() {
    const w = View.w, h = View.h;
    this.scale = clamp(Math.min(h / 640, w / 1080), 0.78, 1.25);
    document.documentElement.style.setProperty('--s', this.scale.toFixed(3));
    document.documentElement.style.setProperty('--m', Math.min(this.scale, h / 500).toFixed(3));   // Menü-Maßstab nach Spielhöhe (auch im gedrehten Modus)
    this.stick.radius = 58 * this.scale;
    if (this.stick.id === null) this.placeStick(null);
  },

  placeStick(x, y) {
    const el = document.getElementById('stick');
    if (x === null) {   // Ruheposition unten links
      const fl = document.body.classList.contains('flying');
      x = 34 + (fl ? 80 : 150) * this.scale;
      y = View.h - 34 - (fl ? 80 : 44) * this.scale;
    }
    this.stick.cx = x; this.stick.cy = y;
    el.style.transform = `translate(${x}px, ${y}px)`;
  },

  bindStick() {
    const zone = document.getElementById('stickZone');
    const el = document.getElementById('stick');
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.stick.id !== null) return;
      this.stick.id = e.pointerId;
      try { zone.setPointerCapture(e.pointerId); } catch (err) { /* nicht kritisch */ }
      // Joystick erscheint unter dem Daumen (nicht zu nah am Rand)
      const fl = document.body.classList.contains('flying');
      const hw = (fl ? 75 : 150) * this.scale, hh = (fl ? 75 : 42) * this.scale;
      const [gx, gy] = View.toGame(e.clientX, e.clientY);
      this.placeStick(clamp(gx, hw + 6, View.w * 0.45), clamp(gy, hh + 10, View.h - hh - 10));
      el.classList.add('active');
      this.moveStick(e);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === this.stick.id) this.moveStick(e); });
    const up = (e) => { if (e.pointerId === this.stick.id) this.endStick(); };
    zone.addEventListener('pointerup', up); zone.addEventListener('pointercancel', up); zone.addEventListener('lostpointercapture', up);
  },

  moveStick(e) {
    const [gx, gy] = View.toGame(e.clientX, e.clientY);
    let dx = gx - this.stick.cx, dy = gy - this.stick.cy;
    if (document.body.classList.contains('flying')) {
      // Fliegen: Kreuz-Joystick (↔ Richtung, ↕ Höhe)
      const r = this.stick.radius, len = Math.hypot(dx, dy);
      if (len > r) { dx *= r / len; dy *= r / len; }
      this.stick.x = dx / r; this.stick.y = -dy / r;
    } else {
      // Fahren: nur links/rechts; je weiter, desto stärker
      const range = 115 * this.scale;
      dx = clamp(dx, -range, range); dy = 0;
      this.stick.x = dx / range; this.stick.y = 0;
    }
    document.getElementById('stickKnob').style.transform = `translate(${dx}px, ${dy}px)`;
  },

  endStick() {
    this.stick.id = null; this.stick.x = 0; this.stick.y = 0;
    document.getElementById('stickKnob').style.transform = '';
    document.getElementById('stick').classList.remove('active');
    this.placeStick(null);
  },

  /** Joystick-Ausschlag → Lenkwert (Totzone + Kurve für feines Lenken um die Mitte). */
  shapeSteer(x) {
    const dz = 0.04;
    const a = Math.abs(x);
    if (a < dz) return 0;
    const sens = { low: 0.9, mid: 1.15, high: 1.4 }[Settings.data.steerSens] || 1;
    // nahezu linear: halber Ausschlag ≈ halber Lenkeinschlag
    return Math.sign(x) * clamp(Math.pow((a - dz) / (1 - dz), 1.0) * sens, 0, 1);
  },

  // ---------- Neigungssteuerung ----------
  /** Muss direkt aus einem Tipp heraus aufgerufen werden (iOS fragt nach Erlaubnis). */
  enableTilt() {
    const start = () => new Promise((resolve, reject) => {
      if (!this.tilt.listening) {
        window.addEventListener('deviceorientation', (e) => this.onOrientation(e));
        this.tilt.listening = true;
      }
      this.tilt.zero = null;
      const t0 = performance.now();
      const check = () => {
        if (this.tilt.last > t0) resolve();
        else if (performance.now() - t0 > 1500) reject(new Error('keine Sensordaten'));
        else setTimeout(check, 100);
      };
      check();
    });
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return Promise.reject(new Error('nicht unterstützt'));
    if (typeof DOE.requestPermission === 'function') {
      return DOE.requestPermission().then((res) => (res === 'granted' ? start() : Promise.reject(new Error('abgelehnt'))));
    }
    return start();
  },

  onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    const ang = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle
      : (typeof window.orientation === 'number' ? window.orientation : 0);
    // Im Querformat entspricht das „Lenkrad-Drehen“ der beta-Achse, im Hochformat gamma
    let roll;
    if (View.forced || ang === 90) roll = -e.beta;
    else if (ang === -90 || ang === 270) roll = e.beta;
    else roll = ang === 180 ? -e.gamma : e.gamma;
    this.tilt.raw = roll;
    if (this.tilt.zero === null) this.tilt.zero = roll;    // Kalibrierung: aktuelle Haltung = geradeaus
    this.tilt.last = performance.now();
  },

  tiltSteer() {
    let d = this.tilt.raw - (this.tilt.zero ?? this.tilt.raw);
    if (d > 180) d -= 360; if (d < -180) d += 360;
    const sens = { low: 30, mid: 22, high: 15 }[Settings.data.steerSens] || 22;   // Grad bis Volleinschlag
    const dz = 1.5;
    if (Math.abs(d) < dz) return 0;
    let v = clamp((Math.abs(d) - dz) / sens, 0, 1) * Math.sign(d);
    if (Settings.data.tiltInvert) v = -v;
    return v;    // +1 = links
  },

  update() {
    const k = this.keys, b = this.btn, st = this.state;
    st.throttle = (k.has('KeyW') || k.has('ArrowUp') || b.gas) ? 1 : 0;
    st.brake = (k.has('KeyS') || k.has('ArrowDown') || b.brake) ? 1 : 0;
    const left = k.has('KeyA') || k.has('ArrowLeft');
    const right = k.has('KeyD') || k.has('ArrowRight');
    let steer = (left ? 1 : 0) - (right ? 1 : 0);      // +1 = links
    if (steer === 0) {
      const tiltOn = Settings.data.steering === 'tilt' && performance.now() - this.tilt.last < 1000;
      steer = tiltOn ? this.tiltSteer() : -this.shapeSteer(this.stick.x);
    }
    st.steer = steer;
    st.stickX = this.stick.x; st.stickY = this.stick.y;
    st.handbrake = k.has('Space') || b.hand;
    st.boost = k.has('ShiftLeft') || k.has('ShiftRight') || b.boost;
    st.fly = b.fly;
    // Steigen/Sinken beim Fliegen: Joystick hoch/runter oder Leertaste/X
    st.climb = (k.has('Space') ? 1 : 0) - (k.has('KeyX') ? 1 : 0) || this.stick.y;
  },
  consume(code) { const had = this.pressed.has(code); this.pressed.delete(code); return had; },
  endFrame() { this.pressed.clear(); },
};

// ============================== Orientation ==============================
/**
 * Spielfläche: Breite/Höhe im Spiel-Koordinatensystem. Steht das Gerät hochkant
 * und dreht die App nicht mit, wird alles um 90° gedreht dargestellt.
 */
const View = {
  forced: false, w: window.innerWidth, h: window.innerHeight,
  update() {
    const W = window.innerWidth, H = window.innerHeight, app = document.getElementById('app');
    const was = this.forced;
    this.forced = Orientation.isPortrait();
    if (this.forced) {
      this.w = H; this.h = W;
      app.style.width = H + 'px'; app.style.height = W + 'px';
      app.style.transform = `translateX(${W}px) rotate(90deg)`;
    } else {
      this.w = W; this.h = H;
      app.style.width = ''; app.style.height = ''; app.style.transform = '';
    }
    document.body.classList.toggle('forced', this.forced);
    if (this.forced && !was) setTimeout(() => toast('Handy quer halten (nach links drehen) – das Spiel ist ins Querformat gedreht.', 3500), 600);
  },
  /** Bildschirmkoordinaten → Spielkoordinaten. */
  toGame(cx, cy) { return this.forced ? [cy, window.innerWidth - cx] : [cx, cy]; },
};

/** Querformat-Erkennung (echte Geräteausrichtung) + Vollbild-Tipp. */
const Orientation = {
  dismissed: false,
  init() {
    const upd = () => this.update();
    window.addEventListener('resize', upd);
    window.addEventListener('orientationchange', () => setTimeout(upd, 150));
    screen.orientation?.addEventListener?.('change', upd);
    upd();
    this.showHint();
  },
  isTouchDevice() { return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1; },
  isPortrait() {
    if (!this.isTouchDevice()) return false;
    // Ist das Fenster selbst klar breiter als hoch, ist es sicher Querformat
    if (window.innerWidth > window.innerHeight * 1.1) return false;
    // Sonst entscheidet die echte Geräteausrichtung (im iframe kann das Fenster hochkant sein,
    // obwohl das Gerät quer gehalten wird – genau daran scheiterte die reine CSS-Abfrage)
    if (typeof window.orientation === 'number') return window.orientation % 180 === 0;
    const t = screen.orientation?.type;
    if (t) return t.startsWith('portrait');
    return window.innerHeight > window.innerWidth * 1.15;
  },
  update() { View.update(); window.__game?.ready && window.__game.resize(); },
  showHint() {
    const hint = document.getElementById('hint'), text = document.getElementById('hintText'), btn = document.getElementById('hintBtn');
    const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (standalone) return;
    if (document.fullscreenEnabled && !ios) {
      text.textContent = 'Für das beste Erlebnis:';
      btn.hidden = false;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.documentElement.requestFullscreen?.().catch(() => {});
        try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch (err) { /* optional */ }
        hint.classList.remove('show');
      });
    } else if (ios) {
      text.textContent = 'Tipp: Teilen → „Zum Home-Bildschirm“ startet das Spiel im Vollbild.';
    } else return;
    hint.classList.add('show');
    hint.addEventListener('pointerdown', () => hint.classList.remove('show'));
    setTimeout(() => hint.classList.remove('show'), 9000);
  },
};

function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

export { Haptics, Input, View, Orientation, toast };
