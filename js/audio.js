import { clamp, approach, Settings } from './config.js';

// ============================== Ton (Web Audio, alles synthetisch) ==============================
/**
 * E-Motor-Surren nach Drehzahl, Wechselrichter-Pfeifen, Reifenquietschen,
 * Abroll- und Windgeräusch, Boost, Flugdüsen, Aufprall, Baum-Krachen.
 * Startet erst nach der ersten Berührung (Browser-Vorgabe).
 */
class SoundFX {
  constructor() { this.ctx = null; this.on = Settings.data.sound !== false; }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.on ? 0.8 : 0;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = noiseBuf;
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; g.connect(this.master); return g; };
    const osc = (type, f, dest) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(dest); o.start(); return o; };
    const noise = (filterType, f, q, dest) => {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
      const fl = ctx.createBiquadFilter(); fl.type = filterType; fl.frequency.value = f; fl.Q.value = q;
      s.connect(fl).connect(dest); s.start(); return fl;
    };
    // E-Motor: zwei Oszillatoren durch Tiefpass, dazu hohes Pfeifen
    this.gEngine = gain(); this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 900; this.lp.connect(this.gEngine);
    this.o1 = osc('sawtooth', 80, this.lp); this.o2 = osc('triangle', 160, this.lp);
    this.gWhine = gain(); this.o3 = osc('sine', 1200, this.gWhine);
    this.gTire = gain(); this.fTire = noise('bandpass', 1300, 4, this.gTire);
    this.gRoad = gain(); this.fRoad = noise('lowpass', 240, 0.7, this.gRoad);
    this.gWind = gain(); this.fWind = noise('lowpass', 600, 0.5, this.gWind);
    this.gBoost = gain(); this.fBoost = noise('bandpass', 700, 1.5, this.gBoost); this.o4 = osc('sawtooth', 110, this.gBoost);
    this.gJet = gain(); this.fJet = noise('bandpass', 380, 0.8, this.gJet);
    // Inverter: getaktete Taktfrequenz, die beim Anfahren in hörbaren Stufen steigt (typisch E-Auto)
    this.gInv = gain(); this.o5 = osc('triangle', 1100, this.gInv);
    // Reifenquietschen: tonaler Anteil mit leichtem Vibrato (zum Rauschen dazu)
    this.gSq = gain(); this.o6 = osc('sine', 950, this.gSq);
    this.lfo = osc('sine', 7, (() => { const g = ctx.createGain(); g.gain.value = 22; g.connect(this.o6.frequency); return g; })());
  }
  setOn(on) { this.on = on; if (this.master) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.05); }
  set(param, v, tc = 0.06) { param.setTargetAtTime(v, this.ctx.currentTime, tc); }

  update(v) {
    if (!this.ctx || !this.on) return;
    const rpmF = clamp(v.drivetrain.rpm / v.cfg.motor.redline, 0, 1.1), sp = v.speed;
    const load = v.flying ? 0.3 : v.throttle;
    const f = 55 + rpmF * 480;
    this.set(this.o1.frequency, f); this.set(this.o2.frequency, f * 2.01);
    this.set(this.lp.frequency, 500 + rpmF * 2200 + load * 900);
    this.set(this.gEngine.gain, (0.025 + load * 0.09) * (0.35 + rpmF * 0.8));
    this.set(this.o3.frequency, 700 + rpmF * 4200);
    this.set(this.gWhine.gain, 0.006 + load * 0.018 * rpmF);
    let slide = 0, asphalt = 0;
    for (const w of v.wheels) if (w.grounded) { slide = Math.max(slide, w.slideAmount); if (w.grip >= 1) asphalt++; }
    this.set(this.gTire.gain, asphalt > 1 ? clamp(slide, 0, 1) * clamp(sp / 8, 0, 1) * 0.22 : 0, 0.04);
    this.set(this.fTire.frequency, 1000 + slide * 700);
    const offroad = v.groundedCount > 0 && asphalt < 2;
    this.set(this.gRoad.gain, v.groundedCount ? clamp(sp / 40, 0, 1) * (offroad ? 0.2 : 0.07) : 0);
    this.set(this.fRoad.frequency, offroad ? 420 : 240);
    this.set(this.gWind.gain, Math.min(0.32, (sp / 85) ** 2 * 0.28) + (v.flying ? 0.05 : 0));
    this.set(this.fWind.frequency, 300 + sp * 9);
    this.set(this.gBoost.gain, v.boosting ? 0.12 : 0, 0.08);
    this.set(this.fBoost.frequency, v.boosting ? 900 + sp * 8 : 500);
    this.set(this.o4.frequency, 90 + sp * 1.2);
    this.set(this.gJet.gain, v.flying ? 0.1 + v.throttle * 0.06 : 0, 0.15);
    // Inverter-Stufen nur bei niedrigem Tempo unter Last
    const step = Math.min(4, Math.floor(sp / 2.2));
    this.set(this.o5.frequency, 900 + step * 420 + (sp % 2.2) * 60, 0.015);
    this.set(this.gInv.gain, v.flying ? 0 : load * clamp(1 - sp / 11, 0, 1) * 0.016, 0.05);
    // tonales Quietschen ab deutlichem Schlupf, Tonhöhe steigt mit dem Rutschen
    const sq = asphalt > 1 ? clamp((slide - 0.15) / 0.6, 0, 1) * clamp(sp / 10, 0, 1) : 0;
    this.set(this.gSq.gain, sq * 0.05, 0.04);
    this.set(this.o6.frequency, 820 + slide * 380, 0.05);
  }

  /** Kurzer Warnton (z. B. Festnahme-Timer). */
  beep(freq = 880, dur = 0.12) {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }

  /** Kurzer Knall/Rumms (Stärke ~ Aufprallgeschwindigkeit in m/s). */
  impact(strength, kind = 'hit') {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = kind === 'tree' ? 'bandpass' : 'lowpass'; f.frequency.value = kind === 'tree' ? 900 : 380; f.Q.value = kind === 'tree' ? 2 : 0.8;
    const g = ctx.createGain(); const peak = clamp(strength / 15, 0.08, 0.9);
    g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'tree' ? 0.55 : 0.35));
    s.connect(f).connect(g).connect(this.master); s.start(t, Math.random()); s.stop(t + 0.6);
    // tiefer Schlag
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(kind === 'tree' ? 70 : 95, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.25);
    const og = ctx.createGain(); og.gain.setValueAtTime(peak * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.32);
    if (kind === 'tree') {   // Ast-Knacken
      for (let k = 0; k < 4; k++) {
        const s2 = ctx.createBufferSource(); s2.buffer = this.noiseBuf;
        const f2 = ctx.createBiquadFilter(); f2.type = 'highpass'; f2.frequency.value = 2500;
        const g2 = ctx.createGain(); const tt = t + 0.08 + k * 0.09 + Math.random() * 0.05;
        g2.gain.setValueAtTime(0.0001, t); g2.gain.setValueAtTime(peak * 0.5, tt); g2.gain.exponentialRampToValueAtTime(0.001, tt + 0.06);
        s2.connect(f2).connect(g2).connect(this.master); s2.start(t, Math.random()); s2.stop(tt + 0.1);
      }
    }
  }
}

// ============================== Ton: Sirenen & Hubschrauber ==============================
Object.assign(SoundFX.prototype, {
  policeOn(on) {
    this.policeActive = on;
    if (!this.ctx) return;
    if (!this.sirens) this.makeSirens();
    if (!on) { for (const s of this.sirens) this.set(s.g.gain, 0, 0.15); this.set(this.rotorG.gain, 0, 0.3); }
  },
  makeSirens() {
    const ctx = this.ctx;
    this.sirens = [0, 1, 2].map((i) => {
      const o = ctx.createOscillator(); o.type = 'square';
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.value = 0;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      o.connect(f).connect(g);
      if (pan) g.connect(pan).connect(this.master); else g.connect(this.master);
      o.start();
      return { o, f, g, pan, phase: i * 0.31 };
    });
    // Rotor: tiefes Rauschen, rhythmisch moduliert
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    const am = ctx.createGain(); am.gain.value = 0.5;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 16; const lg = ctx.createGain(); lg.gain.value = 0.5;
    lfo.connect(lg).connect(am.gain); lfo.start();
    this.rotorG = ctx.createGain(); this.rotorG.gain.value = 0;
    src.connect(lp).connect(am).connect(this.rotorG).connect(this.master); src.start();
  },
  /** Sirenen der drei nächsten Wagen: auf- und abschwellender Ton, Doppler-Effekt, Stereo-Position. */
  updatePolice(police, lis, lvel, camRight, time) {
    if (!this.ctx || !this.on || !police.active) return;
    if (!this.sirens) this.makeSirens();
    const units = police.units.filter((u) => u.active).sort((a, b) => a.pos.distanceToSquared(lis) - b.pos.distanceToSquared(lis)).slice(0, 3);
    const t = this.ctx.currentTime;
    this.sirens.forEach((s, i) => {
      const u = units[i];
      if (!u) { this.set(s.g.gain, 0, 0.1); return; }
      const dx = lis.x - u.pos.x, dy = lis.y - u.pos.y, dz = lis.z - u.pos.z, d = Math.hypot(dx, dy, dz) || 1;
      const ph = (time / 3.4 + s.phase) % 1;
      const base = 640 + (0.5 - 0.5 * Math.cos(ph * Math.PI * 2)) * 860;
      const approach = ((u.vel.x - lvel.x) * dx + (u.vel.y - lvel.y) * dy + (u.vel.z - lvel.z) * dz) / d;
      const f = base * 343 / (343 - clamp(approach, -160, 160));
      s.o.frequency.setTargetAtTime(f, t, 0.02); s.f.frequency.setTargetAtTime(f * 1.05, t, 0.04);
      this.set(s.g.gain, clamp(9 / (d + 8), 0, 0.2) * (i === 0 ? 1 : 0.7), 0.05);
      if (s.pan) this.set(s.pan.pan, clamp(-(dx * camRight.x + dz * camRight.z) / d, -1, 1) * 0.85, 0.05);
    });
    const h = police.heli;
    this.set(this.rotorG.gain, h && police.D.heli ? clamp(30 / (h.pos.distanceTo(lis) + 20), 0, 0.35) : 0, 0.2);
  },
});

// ============================== Musik (generiert) ==============================
/**
 * Synthwave-Schleife, komplett erzeugt (keine Dateien): Flächen, Bass-Arpeggio,
 * Kick, Snare, Hi-Hats. Planung mit Vorlauf über die Audio-Uhr (taktgenau).
 */
class Music {
  constructor(sound) { this.s = sound; this.on = Settings.data.music !== false; this.playing = false; }
  start() {
    const ctx = this.s.ctx;
    if (!ctx || this.playing || !this.on) return;
    this.playing = true;
    this.out = ctx.createGain(); this.out.gain.value = 0.0001; this.out.connect(this.s.master);
    this.out.gain.setTargetAtTime(0.16, ctx.currentTime, 1.5);
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 2200; this.lp.connect(this.out);
    this.bpm = 102; this.step = 0; this.next = ctx.currentTime + 0.1;
    // Akkorde (Am – F – C – G), Grundton in Hz
    this.chords = [[220, 261.6, 329.6], [174.6, 220, 261.6], [130.8, 164.8, 196], [196, 246.9, 293.7]];
    this.timer = setInterval(() => this.schedule(), 30);
  }
  stop() {
    if (!this.playing) return;
    this.playing = false; clearInterval(this.timer);
    const ctx = this.s.ctx; this.out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4);
    const o = this.out; setTimeout(() => o.disconnect(), 2000);
  }
  setOn(on) { this.on = on; if (on) this.start(); else this.stop(); }
  schedule() {
    const ctx = this.s.ctx, sp = 60 / this.bpm / 4;            // Sechzehntel
    while (this.next < ctx.currentTime + 0.15) {
      const st = this.step % 64, bar = Math.floor(st / 16), beat = st % 16, t = this.next;
      const ch = this.chords[bar];
      if (beat === 0) for (const f of ch) this.pad(t, f, sp * 16);
      if (beat % 2 === 0) this.bass(t, ch[[0, 0, 2, 0, 1, 0, 2, 1][beat / 2]] / 2, sp * 1.8);
      if (beat % 4 === 0) this.kick(t);
      if (beat === 4 || beat === 12) this.snare(t);
      if (beat % 2 === 1) this.hat(t, beat % 4 === 3 ? 0.05 : 0.03);
      this.next += sp; this.step++;
    }
  }
  env(g, t, a, peak, d) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + d); }
  pad(t, f, dur) {
    const ctx = this.s.ctx;
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      const g = ctx.createGain(); this.env(g, t, 0.6, 0.05, dur);
      o.connect(g).connect(this.lp); o.start(t); o.stop(t + dur + 0.1);
    }
  }
  bass(t, f, dur) {
    const ctx = this.s.ctx, o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
    const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.setValueAtTime(900, t); fl.frequency.exponentialRampToValueAtTime(180, t + dur);
    const g = ctx.createGain(); this.env(g, t, 0.01, 0.12, dur);
    o.connect(fl).connect(g).connect(this.out); o.start(t); o.stop(t + dur + 0.05);
  }
  kick(t) {
    const ctx = this.s.ctx, o = ctx.createOscillator(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const g = ctx.createGain(); this.env(g, t, 0.004, 0.5, 0.28);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.3);
  }
  noise(t, type, f, peak, dur) {
    const ctx = this.s.ctx, src = ctx.createBufferSource(); src.buffer = this.s.noiseBuf;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f;
    const g = ctx.createGain(); this.env(g, t, 0.002, peak, dur);
    src.connect(fl).connect(g).connect(this.out); src.start(t, Math.random()); src.stop(t + dur + 0.02);
  }
  snare(t) { this.noise(t, 'bandpass', 1800, 0.22, 0.2); }
  hat(t, v) { this.noise(t, 'highpass', 7000, v, 0.05); }
}

export { SoundFX, Music };
