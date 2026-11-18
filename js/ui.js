import { Settings } from './config.js';
import { Haptics, Input, toast } from './input.js';
import { DynRes } from './menu.js';
import { game } from './main.js';

// ============================== UI (Einstellungen) ==============================
const UI = {
  init(game) {
    this.game = game;
    const panel = document.getElementById('settings');
    document.getElementById('btnSettings').addEventListener('pointerdown', (e) => { e.preventDefault(); this.open(true); });
    document.getElementById('btnClose').addEventListener('click', () => this.open(false));
    document.getElementById('btnBench').addEventListener('click', () => { this.open(false); game.runBenchmark(); });
    document.getElementById('btnReset').addEventListener('pointerdown', (e) => { e.preventDefault(); game.resetCar(); Haptics.pulse(20); });
    document.getElementById('btnCam').addEventListener('pointerdown', (e) => { e.preventDefault(); game.nextCamera(); });
    document.getElementById('btnEgo').addEventListener('pointerdown', (e) => { e.preventDefault(); game.toggleEgo(); });
    document.getElementById('btnPolice').addEventListener('pointerdown', (e) => { e.preventDefault(); if (!game.missions.active) game.togglePolice(); });
    document.getElementById('btnMissions').addEventListener('pointerdown', (e) => { e.preventDefault(); game.missions.openList(); });
    document.getElementById('btnGarage').addEventListener('pointerdown', (e) => { e.preventDefault(); game.openGarage(); });
    document.getElementById('mClose').addEventListener('click', () => { document.getElementById('missions').hidden = true; game.paused = false; });
    document.getElementById('resBtn').addEventListener('click', () => { document.getElementById('result').hidden = true; game.paused = false; });
    document.getElementById('btnEgo').classList.toggle('on', game.rig.mode === 'cockpit');
    panel.querySelectorAll('.seg').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        const key = seg.dataset.key; let val = b.dataset.v;
        if (val === 'true') val = true; else if (val === 'false') val = false;
        if (key === 'steering' && val === 'tilt') {
          // Neigungssensor braucht auf iOS eine Erlaubnis – direkt aus dem Tipp heraus anfragen
          Input.enableTilt().then(() => {
            Settings.data.steering = 'tilt'; Settings.save(); game.applySettings(); this.sync();
            toast('Neigen aktiv: Halte das Gerät in Fahrhaltung, das ist „geradeaus“.', 3000);
          }).catch(() => {
            Settings.data.steering = 'stick'; Settings.save(); game.applySettings(); this.sync();
            toast('Neigungssensor ist hier nicht verfügbar. Lenkung bleibt beim Joystick.', 3200);
          });
          return;
        }
        Settings.data[key] = val; Settings.save();
        if (key === 'sound') game.sound.setOn(val);
        if (key === 'music') game.music.setOn(val);
        if (key === 'dynres' && !val) { DynRes.scale = 1; game.resize(); }
        game.applySettings(); this.sync();
      });
    });
    this.sync();
  },
  open(on) {
    document.getElementById('settings').classList.toggle('open', on);
    this.game.paused = on;
    if (on) Input.releaseAll();
    else Input.tilt.zero = null;     // beim Weiterfahren Neigung neu kalibrieren
  },
  sync() {
    document.querySelectorAll('#settings .seg').forEach((seg) => {
      const val = String(Settings.data[seg.dataset.key]);
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.v === val));
    });
  },
};

export { UI };
