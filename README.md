# Roadster Escape

Open-World-Fahrspiel im Browser (HTML5 + Three.js), gebaut für iPhone und iPad im Querformat mit Touch-Steuerung.
Der Spieler fährt den **Voltara Aero R**, einen elektrischen Hypercar-Roadster.

## Starten

`index.html` über einen beliebigen Webserver öffnen, z. B.:

```bash
python3 -m http.server 8080
# dann http://localhost:8080 (oder im WLAN: http://<IP-des-Rechners>:8080 auf dem iPad)
```

Three.js wird per CDN geladen (`three@0.160.0`). Es gibt keine Build-Tools und keine externen Dateien.

## Steuerung (Stand Phase 1)

| Aktion | Touch | Tastatur (zum Testen) |
|---|---|---|
| Gas | GAS | W / ↑ |
| Bremse / Rückwärts | BREMSE (im Stand halten → R) | S / ↓ |
| Lenken | ◀ ▶ | A / D, ← / → |
| Handbremse | HAND-BREMSE | Leertaste |
| Gang hoch/runter (manuell) | ▲ ▼ | E / Q |
| Auto zurücksetzen | ↺ | R |
| Telemetrie | Einstellungen | T |

Die Touch-Knöpfe in Phase 1 sind vorläufig. In Phase 2 werden sie durch Joystick, Gyro-Lenkung usw. ersetzt.

## Fortschritt

- [x] **Phase 1 – Grundgerüst und Fahrphysik**
- [ ] Phase 2 – Touch-Steuerung
- [ ] Phase 3 – Kameras
- [ ] Phase 4 – Offene Welt
- [ ] Phase 5 – Kollisionen
- [ ] Phase 6 – Boost und Fliegen
- [ ] Phase 7 – Polizei-Modus
- [ ] Phase 8 – Missionen
- [ ] Phase 9 – Garage und Upgrades
- [ ] Phase 10 – Feinschliff und Veröffentlichung

## Technik (Phase 1)

- **Spielschleife:** feste Physik-Schrittweite von 120 Hz mit Akkumulator. Die Darstellung wird zwischen zwei Physik-Zuständen interpoliert.
- **Fahrzeugphysik (Raycast-Modell):** Starrkörper mit 6 Freiheitsgraden und vier Strahlen gegen das Höhenfeld.
  - Feder und Dämpfer (Druck- und Zugstufe getrennt) pro Rad, Stabilisatoren, Anschlagpuffer
  - Reifen: vereinfachte Pacejka-Formel für Seitenkräfte, Reibungskreis für Längs- und Querkraft, lastabhängiger Grip, Gleitreibung → Driften bei Grip-Verlust
  - Gewichtsverlagerung entsteht physikalisch: Die Kräfte greifen am Aufstandspunkt unter dem Schwerpunkt an
  - Luftwiderstand (cW·A) und Abtrieb
  - E-Motor: volles Drehmoment ab 0 U/min, darüber konstante Leistung; Rekuperation beim Gaswegnehmen
  - Allradantrieb (38 % vorne / 62 % hinten), ABS, abschaltbare Fahrhilfen (Traktions- und Stabilitätskontrolle)
- **Getriebe:** Automatik als Standard (inklusive Rückwärtsgang durch Halten der Bremse). Handschaltung mit 6 Gängen, R und N, Überdrehschutz.
- **Messwerte:** 0–100 km/h in ≈ 2,2 s, Spitze ≈ 340 km/h auf der Startbahn, ≈ 1,25 g Querbeschleunigung.
- **Grafikstufen:** Niedrig, Mittel und Hoch (Pixeldichte, Schatten, Lackmaterial, Geometrie-Details).
- **Testgelände:** Asphaltfläche mit Skidpad und Slalom, 1,9 km lange Startbahn, vier Rampen, Wellenpiste und Hügel rundherum. Unsichtbare Weltgrenzen.

## Code-Aufbau

Bis Phase 9 steckt alles in `index.html`, in klar getrennten Abschnitten:
`CONFIG`, `Settings`, `Input`, `World`, `Drivetrain`, `Vehicle`, `CarModel`, `SkidMarks`, `CameraRig`, `HUD`, `Game`, `UI`.
In Phase 10 wird der Code in einzelne Module aufgeteilt.
