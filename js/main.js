/* =====================================================================
   ROADSTER ESCAPE – Phasen 1–6: Fahrphysik, Touch, Kameras, Welt, Kollisionen, Boost & Fliegen
   ---------------------------------------------------------------------
   Module (in dieser Datei als Abschnitte, ab Phase 10 eigene Dateien):
     CONFIG      – alle Abstimmungswerte an einem Ort
     Settings    – Einstellungen + localStorage
     Haptics     – Vibration (Android) bzw. iOS-Haptik-Trick
     Input       – Tastatur, Joystick, Neigen, Touch-Knöpfe (Multitouch)
     Orientation – Querformat-Hinweis, Vollbild-Tipp
     Drivetrain  – E-Motor-Kennlinie, Getriebe (Automatik/Manuell)
     Vehicle     – Raycast-Fahrzeugphysik (Federung, Reifen, Aero)
     CarModel    – 3D-Modell des Roadsters „Voltara Aero R“
     SkidMarks   – Reifenspuren
     World       – 4×4-km-Welt: Höhenfeld, Straßengraph, Stadt, Wald, See, Brücke
     Traffic     – Verkehrs-KI (Spuren, Ampeln, Vorfahrt, Ausweichen)
     Environment – Tag/Nacht, Himmel, Nebel, Bloom;  Minimap
     Particles / Grass / RigidBox / SoundFX – Effekte, Gras, Starrkörper, Ton
     CamInput    – Wischen/Zoomen auf freier Fläche
     CameraRig   – Verfolger-, Weit- und Cockpit-Kamera, Wackeln
     HUD         – Tacho, Gang, Drehzahl, Telemetrie
     Game        – Spielschleife mit fester Physik-Schrittweite
   Koordinaten: Y nach oben, Fahrzeug-Vorderseite = lokale −Z, rechts = +X.
   ===================================================================== */
import { Settings } from './config.js';
import { Haptics, Input, View, Orientation } from './input.js';
import { WORLD } from './world/world.js';
import { CamInput } from './camera.js';
import { HUD } from './hud.js';
import { SaveData, POLICE_LEVELS } from './police.js';
import { MISSIONS } from './missions.js';
import { buildCarConfig } from './garage.js';
import { Menu, Tutorial, DynRes } from './menu.js';
import { Game } from './game.js';
import { UI } from './ui.js';

// ============================== Start ==============================
Haptics.init();
Input.init();
Orientation.init();
HUD.init();
const game = new Game();
window.__game = game;          // für Tests/Debugging
Object.assign(window, { Input, CamInput, Settings, WORLD, View, SaveData, POLICE_LEVELS, MISSIONS, buildCarConfig, Menu, Tutorial, DynRes, Haptics });
const loadFill = document.getElementById('lFill'), loadText = document.getElementById('lText');
game.init((p, msg) => { loadFill.style.width = Math.round(p * 100) + '%'; loadText.textContent = msg; })
  .then(() => {
    UI.init(game);
    Menu.init(game);
    Menu.open();
    document.getElementById('loading').classList.add('done');
    setTimeout(() => document.getElementById('loading').remove(), 600);
    // Neigungssteuerung nach dem Neuladen: iOS verlangt die Erlaubnis bei einem Tipp
    if (Settings.data.steering === 'tilt') {
      window.addEventListener('pointerdown', () => Input.enableTilt().catch(() => {
        Settings.data.steering = 'stick'; Settings.save(); game.applySettings(); UI.sync();
      }), { once: true });
    }
  })
  .catch((err) => { loadText.textContent = 'Fehler beim Laden: ' + err.message; console.error(err); });

export { game, loadFill };

// Web-App: offline spielbar machen (nur über http/https, nicht als einzelne Datei)
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !location.hostname.endsWith('claude.ai')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
