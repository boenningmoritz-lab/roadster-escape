import { Settings } from './config.js';
import { Haptics, Input } from './input.js';
import { SaveData, fmtMoney } from './police.js';
import { Garage } from './garage.js';
import { UI } from './ui.js';
import { game } from './main.js';

// ============================== Hauptmenü, Pause, Tutorial ==============================
const Menu = {
  init(game) {
    this.g = game;
    const $ = (id) => document.getElementById(id);
    $('mmFree').addEventListener('click', () => this.close());
    $('mmMissions').addEventListener('click', () => { this.close(); game.missions.openList(); });
    $('mmPolice').addEventListener('click', () => { $('mmPoliceSel').hidden = !$('mmPoliceSel').hidden; });
    document.querySelectorAll('#mmPoliceSel button').forEach((b) => b.addEventListener('click', () => {
      Settings.data.policeLevel = b.dataset.v; Settings.save(); UI.sync();
      this.close(); if (!game.police.active) game.togglePolice();
    }));
    $('mmGarage').addEventListener('click', () => { this.close(); game.openGarage(); });
    $('mmSettings').addEventListener('click', () => { UI.open(true); });
    $('btnMenu').addEventListener('click', () => { UI.open(false); this.open(); });
    $('mmMoney').textContent = '💰 ' + fmtMoney(SaveData.data.money);
  },
  open() {
    const g = this.g;
    if (g.missions.active) g.missions.finish(false, null, true);
    if (g.police.active) { g.police.stop(false); document.getElementById('btnPolice').classList.remove('on'); }
    g.menuOpen = true; g.paused = true; Input.releaseAll();
    document.getElementById('mainMenu').hidden = false;
    document.body.classList.add('inMenu');
    document.getElementById('mmMoney').textContent = '💰 ' + fmtMoney(SaveData.data.money);
    document.getElementById('mmPoliceSel').hidden = true;
  },
  close() {
    const g = this.g;
    g.menuOpen = false; g.paused = false; g.rig.initialized = false;
    document.getElementById('mainMenu').hidden = true;
    document.body.classList.remove('inMenu');
    g.sound.start(); g.music?.start();
    Tutorial.maybeStart(g);
  },
};

/** Kurze Einführung in den ersten Sekunden (nur beim ersten Spielstart). */
const Tutorial = {
  steps: [
    { text: 'Halte <b>GAS</b> gedrückt, um loszufahren.', el: 'tGas', done: (v) => v.throttle > 0.9, min: 1.2 },
    { text: 'Schiebe den <b>Lenk-Schieber</b> nach links oder rechts – je weiter, desto stärker.', el: 'stick', done: () => Math.abs(Input.state.steer) > 0.45, min: 0.8 },
    { text: '<b>BOOST</b> gibt Extra-Schub. Der Ring zeigt die Energie.', el: 'tBoost', done: (v) => v.boosting, min: 0.6 },
    { text: '<b>FLIEGEN</b>: abheben – in der Luft steuerst du mit dem Joystick die Höhe.', el: 'tFly', done: (v) => v.flying, min: 0.5, skip: 9 },
    { text: 'Mit 🎥 und <b>EGO</b> wechselst du die Kamera. 🏁 Missionen, 🚨 Polizei, 🔧 Garage. Viel Spaß!', el: null, done: () => false, skip: 5 },
  ],
  maybeStart(game) {
    if (SaveData.data.tutorialDone || this.active) return;
    this.g = game; this.active = true; this.i = -1; this.next();
  },
  next() {
    const el = document.getElementById('coach');
    document.querySelectorAll('.coachTarget').forEach((e) => e.classList.remove('coachTarget'));
    this.i++;
    if (this.i >= this.steps.length) { this.active = false; el.hidden = true; SaveData.data.tutorialDone = true; SaveData.save(); return; }
    const s = this.steps[this.i];
    el.innerHTML = `<span>${this.i + 1}/${this.steps.length}</span> ${s.text} <button id="coachSkip">Überspringen</button>`;
    el.hidden = false;
    document.getElementById('coachSkip').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.i = this.steps.length - 1; this.next(); });
    if (s.el) document.getElementById(s.el)?.classList.add('coachTarget');
    this.t = 0; this.held = 0;
  },
  update(dt, v) {
    if (!this.active) return;
    const s = this.steps[this.i];
    this.t += dt;
    if (s.done(v)) this.held += dt; else this.held = Math.max(0, this.held - dt * 0.5);
    if (this.held >= s.min || (s.skip && this.t > s.skip)) { Haptics.pulse(15); this.next(); }
  },
};

/** Dynamische Auflösung: hält die Bildrate stabil, indem die Pixeldichte nachgeregelt wird. */
const DynRes = {
  scale: 1, acc: 0, frames: 0, cool: 0,
  update(game, dt) {
    if (Settings.data.dynres === false) return;
    this.acc += dt; this.frames++;
    if (this.acc < 1) return;
    const fps = this.frames / this.acc; this.acc = 0; this.frames = 0;
    if ((this.cool -= 1) > 0) return;
    const target = 56;
    const old = this.scale;
    if (fps < target - 6 && this.scale > 0.55) this.scale = Math.max(0.55, this.scale - (fps < 35 ? 0.15 : 0.08));
    else if (fps > target + 2 && this.scale < 1) this.scale = Math.min(1, this.scale + 0.05);
    if (old !== this.scale) { game.resize(); this.cool = 2; }
  },
};

export { Menu, Tutorial, DynRes };
