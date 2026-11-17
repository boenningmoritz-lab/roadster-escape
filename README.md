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

## Steuerung

| Aktion | Touch | Tastatur (zum Testen) |
|---|---|---|
| Lenken | Joystick links (erscheint unter dem Daumen) oder Neigen | A / D, ← / → |
| Gas | GAS | W / ↑ |
| Bremse / Rückwärts | BREMSE (im Stand halten → R) | S / ↓ |
| Handbremse | HAND-BREMSE | Leertaste |
| Gang hoch/runter (Handschaltung) | ▲ ▼ | E / Q |
| Kamera drehen / zoomen | auf freier Fläche wischen / zwei Finger | Maus ziehen / Mausrad |
| Kamera wechseln (Verfolger, weit, Cockpit) | 🎥 | C |
| Auto zurücksetzen | ↺ | R |

Boost und Fliegen sind schon als Knöpfe da und funktionieren ab Phase 6.

## Fortschritt

- [x] **Phase 1 – Grundgerüst und Fahrphysik**
- [x] Phase 2 – Touch-Steuerung
- [x] Phase 3 – Kameras
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

## Technik (Phase 2 und 3)

- **Touch:** Pointer-Events, jeder Finger einzeln verfolgt (Joystick, Knöpfe und Kamera-Wischen gleichzeitig). Scrollen, Zoomen, Markieren und Long-Press-Menü sind unterdrückt. Die Bedienelemente skalieren mit der Bildschirmgröße.
- **Neigen:** `DeviceOrientation` (auf iOS nach Erlaubnis per Tipp), kalibriert die aktuelle Haltung als „geradeaus“, Richtung umkehrbar.
- **Haptik:** `navigator.vibrate` auf Android; auf dem iPhone (ab iOS 18) über einen versteckten Umschalter, der einen kurzen Haptik-Impuls auslöst.
- **Querformat-Hinweis:** Prüft die echte Geräteausrichtung (`screen.orientation`), nicht das Seitenverhältnis des Fensters. So stimmt er auch, wenn das Spiel eingebettet läuft.
- **Kameras:** Verfolger (weiche Nachführung, fährt nach 1,8 s ohne Berührung zurück hinter das Auto), Verfolger weit und Cockpit mit Innenraum (mitdrehendes Lenkrad, Fahrer- und Mittel-Display mit g-Meter, Sportsitze, Ambientelicht). Kamera wackelt bei Aufprall und harten Landungen.

## Code-Aufbau

Bis Phase 9 steckt alles in `index.html`, in klar getrennten Abschnitten:
`CONFIG`, `Settings`, `Haptics`, `Input`, `Orientation`, `World`, `Drivetrain`, `Vehicle`, `CarModel`, `SkidMarks`, `CamInput`, `CameraRig`, `HUD`, `Game`, `UI`.
In Phase 10 wird der Code in einzelne Module aufgeteilt.
