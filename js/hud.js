import { clamp, Settings } from './config.js';
import { SaveData, fmtMoney } from './police.js';
import { DynRes } from './menu.js';

// ============================== HUD ==============================
const HUD = {
  el: {},
  init() {
    for (const id of ['fps', 'speedVal', 'gearMain', 'gearSub', 'rpmFill', 'telemetry', 'boostFill', 'flyFill', 'altInfo', 'flyLbl', 'tBoost', 'tFly', 'money']) this.el[id] = document.getElementById(id);
    this.last = {};
  },
  set(id, val, prop = 'textContent') {
    if (this.last[id] === val) return;
    this.last[id] = val; this.el[id][prop] = val;
  },
  update(vehicle, fps) {
    const kmh = Math.round(Math.abs(vehicle.forwardSpeed) * 3.6);
    this.set('speedVal', String(kmh));
    const [g, sub] = vehicle.drivetrain.label();
    this.set('gearMain', g); this.set('gearSub', sub);
    const rpmPct = clamp(vehicle.drivetrain.rpm / vehicle.cfg.motor.redline, 0, 1);
    const w = (Math.round(rpmPct * 200) / 2) + '%';
    if (this.last.rpm !== w) { this.last.rpm = w; this.el.rpmFill.style.width = w; }
    this.set('fps', `${fps} FPS · ${Settings.data.quality.toUpperCase()}${DynRes.scale < 1 ? ' · ' + Math.round(DynRes.scale * 100) + ' %' : ''}`);
    this.set('money', '💰 ' + fmtMoney(SaveData.data.money));
    const bw = Math.round(vehicle.boostEnergy * 100) + '%', fw = Math.round(vehicle.flyEnergy * 100) + '%';
    if (this.last.bw !== bw) { this.last.bw = bw; this.el.boostFill.style.width = bw; this.el.tBoost.style.setProperty('--e', vehicle.boostEnergy.toFixed(2)); }
    if (this.last.fw !== fw) { this.last.fw = fw; this.el.flyFill.style.width = fw; this.el.tFly.style.setProperty('--e', vehicle.flyEnergy.toFixed(2)); }
    this.set('altInfo', vehicle.flying ? `HÖHE ${Math.max(0, Math.round(vehicle.altitude))} m${vehicle.landing ? ' · LANDUNG' : ''}` : '');
    this.set('flyLbl', vehicle.flying ? 'landen' : 'abheben');
    if (this.last.flying !== vehicle.flying) { this.last.flying = vehicle.flying; this.el.tFly.classList.toggle('active', vehicle.flying); }
  },
  telemetry(vehicle, extra) {
    if (!Settings.data.telemetry) { this.el.telemetry.style.display = 'none'; return; }
    this.el.telemetry.style.display = 'block';
    const names = ['VL', 'VR', 'HL', 'HR'];
    let s = '';
    vehicle.wheels.forEach((w, i) => {
      s += `${names[i]}  Last ${(w.load / 1000).toFixed(1).padStart(4)} kN  Schräg ${(w.slipAngle * 57.3).toFixed(1).padStart(5)}°  Schlupf ${w.slipRatio.toFixed(2).padStart(5)} ${w.sliding ? '◆' : ' '}\n`;
    });
    s += `Längs ${vehicle.longAccel.toFixed(2)} g   Quer ${vehicle.latAccel.toFixed(2)} g\n`;
    s += `Motor ${Math.round(vehicle.drivetrain.rpm)} U/min   Lenk ${(vehicle.steerAngle * 57.3).toFixed(1)}°\n`;
    s += `0–100 km/h: ${extra.zeroTo100 ? extra.zeroTo100.toFixed(2) + ' s' : '–'}   Vmax: ${Math.round(extra.vmax * 3.6)} km/h\n`;
    s += `Pos ${vehicle.pos.x.toFixed(0)}, ${vehicle.pos.z.toFixed(0)}  Luft ${vehicle.airTime.toFixed(1)} s`;
    this.el.telemetry.textContent = s;
  },
};

export { HUD };
