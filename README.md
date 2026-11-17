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
| Lenken | Schieber links: nur links/rechts, je weiter desto stärker (oder Neigen) | A / D, ← / → |
| Gas | GAS | W / ↑ |
| Bremse / Rückwärts | BREMSE (im Stand halten → R) | S / ↓ |
| Handbremse | HAND-BREMSE | Leertaste |
| Gang hoch/runter (Handschaltung) | ▲ ▼ | E / Q |
| Kamera drehen / zoomen | auf freier Fläche wischen / zwei Finger | Maus ziehen / Mausrad |
| Kamera wechseln (Verfolger, weit, Motorhaube, Cockpit) | 🎥 | C |
| Ego-Perspektive an/aus | EGO | V |
| Boost | BOOST | Shift |
| Fliegen an / Landen | FLIEGEN (in der Luft: Joystick ↕ Höhe, ↔ Richtung) | F (Leertaste/X hoch/runter) |
| Polizei-Verfolgung starten/abbrechen (Stufe in den Einstellungen) | 🚨 | P |
| Auto zurücksetzen (auf die nächste Straße) | ↺ | R |
| Tag / Nacht | Einstellungen | N |


## Fortschritt

- [x] **Phase 1 – Grundgerüst und Fahrphysik**
- [x] Phase 2 – Touch-Steuerung
- [x] Phase 3 – Kameras
- [x] Phase 4 – Offene Welt
- [x] Phase 5 – Kollisionen
- [x] Phase 6 – Boost und Fliegen
- [x] Phase 7 – Polizei-Modus
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

## Technik (Phase 4 – offene Welt)

- **Welt:** 4 × 4 km, bei jedem Start gleich (fester Zufallswert). Höhenfeld im 4-m-Raster aus Rauschen: Hügel, Bergkämme, Randgebirge als natürliche Grenze, See-Becken.
- **Straßennetz als Graph:** Autobahnring (4 Spuren, Mittelleitplanke, Laternen) mit rund 600 m langer Seebrücke, sechs Landstraßen, Stadtraster 8 × 8. Jede Straße bekommt einen geglätteten Höhenverlauf mit begrenzter Steigung und wird ins Gelände geprägt – Einschnitte und Dämme entstehen automatisch.
- **Untergrund:** Asphalt, Gras, Waldboden, Sand und Fels haben eigenen Grip und Rollwiderstand.
- **Stadt:** rund 120 Gebäude mit Fassaden-Shader (Fenster passen zu jeder Gebäudegröße, nachts teils beleuchtet), Parks, Gehwege, Ampeln mit echten Phasen, Zebrastreifen, Straßenlaternen.
- **Wald:** je nach Grafikstufe ca. 6 000 / 15 000 / 25 000 Bäume (Laub- und Nadelbäume) per InstancedMesh, zwei Detailstufen, Kachel-Culling; nahe Bäume mit Blatt- und Nadeltexturen (Alpha-Test).
- **Gelände-Detailstufen:** 10 × 10 Kacheln mit 4-, 8- und 16-m-Auflösung, Ränder mit „Schürzen“ gegen Lücken.
- **Kollisionen:** Gelände, Brückendeck, Dächer (von oben), Hauswände, Leitplanken (überspringbar), Verkehr. Wasser bremst stark; nach kurzer Zeit wird das Auto auf die Straße zurückgesetzt.
- **Verkehr:** Limousinen, Kleinwagen, SUVs und Lkw folgen den Spuren, halten Abstand, stoppen an roten Ampeln, gewähren an Einmündungen Vorfahrt und bremsen bzw. weichen dem Spieler aus. Angefahren rutschen sie physikalisch weg.
- **Tag/Nacht:** Himmel mit Wolken; nachts Mond, Sterne, Scheinwerfer mit Lichtkegel, Laternen mit Lichthöfen und Lichtpfützen, die nächsten Laternen als echte Lichtquellen, beleuchtete Fenster, Ampeln. Auf „Hoch“ zusätzlich Bloom.
- **Minimap** oben links (dreht mit), **Ladebildschirm** während die Welt entsteht.

## Technik (Phase 5 und 6)

- **Bäume:** Unter ~15–25 km/h (je nach Baumgröße) ist der Stamm fest. Darüber knickt der Baum am Stammfuß um und fällt in Stoßrichtung (Drehpunkt unten, Schwerkraft-Moment); das Auto verliert je nach Wucht 15–40 % Tempo. Umgefallene Bäume blenden nach ~5 s aus und wachsen nach 45–75 s wieder nach.
- **Verkehr:** Nach einem Treffer wird das Auto ein echter Starrkörper (6 Freiheitsgrade, Reibung, Bodenkontakt an allen Ecken). Impuls nach Masse und Geschwindigkeit; bei harten Treffern hebelt die flache Front das Auto aus – ab ca. 100 km/h Seitenaufprall überschlägt es sich.
- **Partikel:** Funken (Wände, Leitplanken, Autos), Reifenqualm beim Driften, Staub abseits der Straße, Blätter und Holzsplitter bei Bäumen, Wasserspritzer, Plasma beim Boost.
- **Boost:** Schub im Schwerpunkt (auch in der Luft), Sichtfeld weitet sich, Plasma-Flammen mit Leuchten, Energie lädt nach kurzer Pause langsam wieder auf.
- **Fliegen:** Räder klappen flach unter die Karosserie, vier Hubdüsen leuchten. Joystick ↕ regelt die Steigrate, Gas gibt Schub, Lenken dreht und neigt in die Kurve; die Lage wird automatisch stabilisiert. Flugenergie begrenzt; ist sie leer, setzt automatisch ein sanfter Landeanflug ein.
- **Gras** wiegt im Wind rund um die Kamera, **Ton** komplett synthetisch (E-Motor nach Drehzahl, Wechselrichter-Pfeifen, Reifen, Wind, Abrollgeräusch, Boost, Düsen, Aufprall, Baum-Krachen).

## Technik (Phase 7 – Polizei)

- **Fahrzeuge:** große, fliegende Luxus-SUVs (frei gestaltet) mit Blaulicht-Doppelblitz, „POLIZEI“-Schriftzug, Hubdüsen; nachts werfen die zwei nächsten Wagen echtes blaues Licht.
- **KI:** Verfolgung mit Vorhersage der Fluchtroute (je Stufe stärker), Bremsweg-gerechtes Heranfahren, Einkesseln auf festen Plätzen rund um den Spieler, Rammen, Straßensperren quer auf der vermuteten Route (ab „Schwer“), Ausweichen über Häuser/Bäume/Wasser im Flug, am Spieler herunter auf die Straße.
- **Stufen:** Normal 2 Wagen (langsam), Schwer 4 (schneller), Extrem 6 + Hubschrauber mit Suchscheinwerfer, Insane 10 (sehr aggressiv, weite Vorhersage).
- **Fahndungslevel:** 1–5 Sterne, steigt mit der Zeit und mit Rammstößen; die Polizei wird schneller.
- **Ende:** Entkommen nach 8–18 s außer Sicht (Sichtlinie gegen Gelände und Gebäude), erwischt bei Einkesselung oder Stillstand mit Polizei daneben (Fortschrittsbalken).
- **Belohnung:** Geld nach Stufe, Fluchtzeit und Fahndungslevel; dauerhaft gespeichert.
- **Ton:** Sirenen auf- und abschwellend mit Doppler-Effekt und Stereo-Position, Hubschrauber-Rotor.

## Code-Aufbau

Bis Phase 9 steckt alles in `index.html`, in klar getrennten Abschnitten:
`CONFIG`, `Settings`, `Haptics`, `Input`, `Orientation`, `World` (+ Aufbau), `TrafficSystem`, `Environment`, `Minimap`, `Particles`, `Grass`, `RigidBox`, `SoundFX`, `SaveData`, `PoliceSystem`, `View`, `Drivetrain`, `Vehicle`, `CarModel`, `SkidMarks`, `CamInput`, `CameraRig`, `HUD`, `Game`, `UI`.
In Phase 10 wird der Code in einzelne Module aufgeteilt.
