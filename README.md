# Roadster Escape

Open-World-Fahrspiel im Browser (HTML5 + Three.js), gebaut für iPhone und iPad im Querformat mit Touch-Steuerung.
Der Spieler fährt den **Voltara Aero R**, einen elektrischen Hypercar-Roadster.

## Starten (lokal)

Das Spiel besteht aus ES-Modulen und muss deshalb über einen Webserver geöffnet werden (nicht per Doppelklick):

```bash
python3 -m http.server 8080
# Rechner: http://localhost:8080
# iPad/iPhone im selben WLAN: http://<IP-des-Rechners>:8080
```

Alternativ als **eine einzige Datei**: `dist/roadster-escape.html` (per `python3 tools/bundle.py` aus den Modulen erzeugt) – die lässt sich auch direkt öffnen oder verschicken.

Three.js (`0.160.0`) kommt per CDN. Es gibt keine Build-Tools; das Bündel-Skript ist optional.

## Online stellen (als Web-App für den Home-Bildschirm)

Jeder Anbieter für statische Webseiten funktioniert, es wird nur der Projektordner hochgeladen. Zwei einfache Wege:

**GitHub Pages (kostenlos)**
1. Repository auf GitHub öffnen → *Settings* → *Pages*.
2. Bei *Build and deployment* „Deploy from a branch“ wählen, Branch `main` (bzw. den gewünschten) und Ordner `/ (root)`, speichern.
3. Nach ca. einer Minute ist das Spiel unter `https://<benutzer>.github.io/<repo>/` erreichbar.

**Netlify Drop (ohne Konto-Einrichtung)**
1. <https://app.netlify.com/drop> öffnen.
2. Den Projektordner (mit `index.html`, `css/`, `js/`, `icons/`, `manifest.webmanifest`, `sw.js`) ins Fenster ziehen.
3. Netlify zeigt sofort eine Adresse an.

**Auf dem iPhone/iPad installieren**
1. Die Adresse in **Safari** öffnen.
2. *Teilen* → **„Zum Home-Bildschirm“**.
3. Das Spiel startet dann wie eine App: Vollbild, Querformat, eigenes Symbol. Nach dem ersten Start ist es dank Service Worker auch **offline** spielbar.

Nach Änderungen an den Dateien in `sw.js` die `VERSION` erhöhen, damit installierte Geräte die neue Fassung laden.

## Steuerung

| Aktion | Touch | Tastatur (zum Testen) |
|---|---|---|
| Lenken | Touch-Lenkrad links: Daumen auflegen und drehen (±270°), oder Neigen | A / D, ← / → |
| Gas | GAS | W / ↑ |
| Bremse / Rückwärts | BREMSE (im Stand halten → R) | S / ↓ |
| Handbremse | HAND-BREMSE | Leertaste |
| Kamera drehen / zoomen | auf freier Fläche wischen / zwei Finger | Maus ziehen / Mausrad |
| Kamera wechseln (Verfolger, weit, Motorhaube, Cockpit) | 🎥 | C |
| Ego-Perspektive an/aus | EGO | V |
| Boost | BOOST | Shift |
| Fliegen an / Landen | FLIEGEN (in der Luft: Joystick ↕ Höhe, ↔ Richtung) | F (Leertaste/X hoch/runter) |
| Polizei-Verfolgung starten/abbrechen (Stufe in den Einstellungen) | 🚨 | P |
| Missionen (Liste) – oder in eine gelbe Lichtsäule fahren | 🏁 | – |
| Garage (Upgrades, Lack, Felgen, Innenraum) | 🔧 | G |
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
- [x] Phase 8 – Missionen
- [x] Phase 9 – Garage und Upgrades
- [x] Phase 10 – Feinschliff und Veröffentlichung

## Technik (Phase 1)

- **Spielschleife:** feste Physik-Schrittweite von 120 Hz mit Akkumulator. Die Darstellung wird zwischen zwei Physik-Zuständen interpoliert.
- **Fahrzeugphysik (Raycast-Modell):** Starrkörper mit 6 Freiheitsgraden und vier Strahlen gegen das Höhenfeld.
  - Feder und Dämpfer (Druck- und Zugstufe getrennt) pro Rad, Stabilisatoren, Anschlagpuffer
  - Reifen: vereinfachte Pacejka-Formel für Seitenkräfte, Reibungskreis für Längs- und Querkraft, lastabhängiger Grip, Gleitreibung → Driften bei Grip-Verlust
  - Gewichtsverlagerung entsteht physikalisch: Die Kräfte greifen am Aufstandspunkt unter dem Schwerpunkt an
  - Luftwiderstand (cW·A) und Abtrieb
  - E-Motor: volles Drehmoment ab 0 U/min, darüber konstante Leistung; Rekuperation beim Gaswegnehmen
  - Allradantrieb (38 % vorne / 62 % hinten), ABS, abschaltbare Fahrhilfen (Traktions- und Stabilitätskontrolle)
- **Getriebe:** nur Automatik mit 6 Gängen (Rückwärtsgang durch Halten der Bremse).
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

## Technik (Phase 8 – Missionen, Realismus)

- **14 Missionen, 8 Arten:** Checkpoint-Rennen (Stadtrunde, Nachtfahrt), Flug-Parcours (Erster Flug, Waldschneise), Holzfäller, Drift-König, Weitsprung, Polizei-Flucht (Ausbruch, Großfahndung, Staatsfeind Nr. 1), Lieferung ohne Polizeikontakt (Eilige Lieferung, Nachtkurier), Rennen gegen KI-Gegner (Autobahn-Duell, Brückenrennen). Nachtmissionen schalten die Tageszeit um.
- **Ablauf:** Startpunkte als gelbe Lichtsäulen in der Welt und auf der Minimap, Countdown, Checkpoint-Tore bzw. Ringe, Richtungspfeil über dem Auto, Bronze/Silber/Gold, Geld (nur die Verbesserung wird ausgezahlt), Freischaltung nach und nach.
- **Routen** folgen dem Straßennetz (Dijkstra-Wegsuche); KI-Gegner fahren mit kurvenabhängigem Tempo und „Gummiband“.
- **Realismus:** Bodentexturen (Gras, Waldboden, Fels, Sand) nach Gelände gemischt, in zwei Maßstäben gegen Kachelmuster; Kontaktschatten unter allen Fahrzeugen; Bäume wiegen im Wind; Gebäude unten abgedunkelt; leichte Vignette.
- **Querformat erzwingen:** Bleibt die App im Hochformat (z. B. eingebettet), dreht sich das Spiel selbst um 90°.

## Technik (Phase 9 – Garage)

- **Ausstellungsraum** mit Drehteller (per Finger drehbar), Studio-Reflexionen, Lichtleisten, Schatten.
- **9 Upgrades × 5 Stufen** ändern die Physik: Motor (+9 % Leistung/Stufe), Höchstgeschwindigkeit (−5 % cW·A, +600 U/min), Beschleunigung (+8 % Drehmoment, −2 % Gewicht), Grip (+4 % Haftung, straffere Stabis), Bremsen (+12 %), Boost-Stärke/-Dauer, Flugzeit, Flugsteuerung. Beispiel: alles auf Stufe 3 → 0–100 km/h 2,22 s → 1,96 s.
- **Optik:** Lackfarbe (Farbwähler + Vorschläge), Glanz/Metallic/Matt, 4 Felgendesigns in 5 Farben, Unterbodenbeleuchtung (6 Farben), Spoiler (Lippe/Flügel – der Flügel erhöht den Abtrieb wirklich).
- **Innenraum** (im Cockpit sichtbar): Sitzfarbe, Lenkrad rund/Yoke/Sport, Ambientelicht, Display-Design.
- **Speicherstand** in localStorage: Geld, Upgrades, gekaufte Optik, Missionen, Einstellungen.

## Technik (Phase 10 – Feinschliff)

- **Hauptmenü** mit animiertem Logo über einer Kamerafahrt um das Auto: Freie Fahrt, Missionen, Polizei-Modus (Stufenwahl), Garage, Einstellungen. **Pause** über ⚙︎ (mit Rückkehr ins Hauptmenü).
- **Tutorial** beim ersten Start: Gas, Lenken, Boost, Fliegen, Kameras – Schritt für Schritt mit leuchtender Markierung, überspringbar.
- **Musik:** generierter Synthwave-Soundtrack (Flächen, Bass, Drums), abschaltbar.
- **Dynamische Auflösung:** misst die Bildrate und regelt die Pixeldichte (55–100 %) nach, damit es auf iPad und iPhone flüssig bleibt.
- **Web-App:** Manifest (Vollbild, Querformat, Symbole) und Service Worker (offline).
- **Code-Aufteilung** in Module (siehe unten); `tools/bundle.py` erzeugt daraus wieder eine Einzeldatei.

## Technik (Realismus-Paket)

- **Wetter** (Einstellungen): Sonnig, Bewölkt, Regen, Nebel. Regen: Tropfen-Streifen um die Kamera (auf der Grafikkarte animiert), nasse, spiegelnde Fahrbahn, 22 % weniger Grip auf Asphalt, Gischt hinter den Reifen, Regenrauschen, Blitz und Donner (mit Laufzeitverzögerung).
- **Bergkulisse** am Horizont mit Luftperspektive und Schneekuppen.
- **Felsen und Büsche** rund um die Kamera, je nach Untergrund (Hänge, Waldboden, Wiese).
- **Straßenausstattung:** Leitpfosten mit Reflektoren (nachts leuchtend) an Landstraßen, Tempo-Schilder, gelbe Ortsschilder „Voltstadt“, blaue Autobahn-Wegweiser.
- **Ladenzeilen** im Erdgeschoss der Stadthäuser mit Schaufenstern und farbigen Schildern, nachts teils beleuchtet.
- **Sonnenreflex** (Lens Flare) beim Blick in die Sonne.

## Technik (Realismus-Paket 2)
- **Lenkung kräftiger:** größerer Lenkeinschlag (0,6 rad), schnellere Lenkrate, höhere Empfindlichkeit; ca. 1,15 g Querbeschleunigung bei allen Tempi, stabil ohne Dreher.
- **Tageszeit „Abend“:** tiefe Sonne, orange Horizont, warmer Nebel; Licht an Autos und Laternen.
- **Filmischer Look:** eigener Shader-Pass mit leichter chromatischer Aberration, S-Kurve, Split-Toning und Filmkorn.
- **Scheinwerferkegel:** sichtbare Lichtkegel und Leuchtpunkte, bei Regen/Nebel stärker (Lichtstreuung).
- **Geparkte Autos** am Straßenrand der Stadt (anfahrbar, kehren danach an ihren Platz zurück).
- **Lichthöfe** an Scheinwerfern und Rücklichtern des Verkehrs bei Nacht.

## Technik (Realismus-Paket 3)
- **Lenkung deutlich stärker:** warme Semislicks (μ 1,75) plus echter Hypercar-Abtrieb (ClA 2,4) → bis 1,6 g Querbeschleunigung, 9 m Wendekreis bei 40 km/h. Kürzerer Lenk-Schieberweg, schnellere Lenkung, kräftigere Eindreh-Hilfe (ESP führt das Heck nach).
- **Nur noch Automatik:** Handschaltung, Schalt-Tasten und Einstellung entfernt.
- **Verkehrsautos neu modelliert:** ausgeschnittene Radhäuser, sichtbare Reifen mit 5-Speichen-Felgen, eingezogene Dachlinie, Spiegel, Grill, Kennzeichen; Lack nur auf der Karosserie (Glas/Reifen bleiben dunkel).
- **Asphalt:** heller, warmgrau, Splitt-Körnung als Bump-Map, Flickstellen, Risse, Ölspur, abgefahrene Markierungen.
- **Gebäude:** Fensterscheiben spiegeln Himmel und Umgebung (Fresnel), Attika und Gesims an jedem Haus.
- **Fehler behoben:** Tutorial-Hinweis verdeckte Fahndungssterne und lag über der Garage.

## Technik (Realismus-Paket 4 – Lenkrad & Cockpit)
- **Touch-Lenkrad** statt Schieber: Leder mit Ziernaht, Carbon-Speichen, 12-Uhr-Markierung. Daumen aufs Lenkrad (oder irgendwo links) legen und **drehen**; Anschlag ±270° (Empfindlichkeit: 360°/270°/200°), 2° Totzone. Losgelassen schnellt es zurück zur Mitte (bei Fahrt ca. 0,5 s, im Stand ca. 0,9 s).
- **Echte Lenkübersetzung:** Lenkrad → Vorderräder ≈ 10,5 : 1 bei 270°, ab ca. 30 km/h zunehmend indirekter. Das Bildschirm-Lenkrad, das Cockpit-Lenkrad und die Räder zeigen immer denselben Winkel.
- **Menschliche Lenkbewegung:** kritisch gedämpft, Handbeschleunigung begrenzt, max. 540°/s (Gegenlenken 720°/s). 1 cm am Kranz ≈ 40° Lenkrad ≈ 3,8° Radeinschlag; voller Anschlag in ≈ 0,8 s.
- **Cockpit:** geschwungenes Alcantara-Armaturenbrett mit Ziernaht, Hutze, vier Lüftungsdüsen, Carbon-Mitteltunnel mit Wählhebel und Tasten, Türverkleidung mit Armauflage und Lautsprecher, schlanke A-Säulen statt dickem Bogen, Innenspiegel; Hände in Handschuhen (9/3 Uhr) mit Umgreifen, Unterarme. Kopf schwingt gedämpft mit den g-Kräften, FOV 72°. Großer HUD-Tacho in der Ego-Sicht ausgeblendet.
- **Fehler behoben:** FPS-Zeile nur noch mit Telemetrie; kein schwarzes Bild nach „Freie Fahrt“ (Auflösung wird vor dem Rendern angepasst, beim Start gesperrt); geparkte Autos mit Abstand zum Bordstein und zu Kreuzungen; Missions-Fenster nur beim langsamen Hineinfahren (nicht beim Spawnen im Ring) und kompakt links; Tutorial oben rechts, Toasts mittig – nichts verdeckt Tacho, Sterne, Lenkrad oder Pedale; Außenspiegel sitzen fest auf der Tür.

- **Verkehr:** Bremslichter beim Verzögern und im Stand, Blinker ca. 45 m vor dem Abbiegen (Abbiegerichtung wird vorab gewählt).
- **Spieler-Auto:** Klarlack mit „Orangenhaut“-Struktur (Grafik Hoch); Bremsscheiben heizen sich bei harten Bremsungen auf und glühen orange-rot.
- **Ton & Haptik:** Inverter-Pfeifen in hörbaren Stufen beim Anfahren, tonales Reifenquietschen mit Vibrato; Vibration beim Rutschen und bei Bordstein-/Kantenkontakt.
- **Gras:** feine, weichere Halme mit Farbverlauf (unten dunkel, Spitzen heller/gelblich), einzelne trockene Halme und Rispen.

## Technik (Realismus-Paket 5 – Stadt, Wetter, Details)
- **Stadt** (`js/world/street.js`): Granit-Bordsteine, Gehwegplatten (50 cm, in Weltkoordinaten), Kanaldeckel und Gullys; rund 700 Stadtmöbel (Mülleimer, Parkscheinautomaten, Poller, Bänke, Hydranten), die beim Anfahren wegfliegen und später wieder dastehen; Fußgänger (Niedrig 16 / Mittel 45 / Hoch 90) laufen mit Bein- und Armschwung um die Blöcke und springen vor schnellen Autos zur Hauswand.
- **Fassaden:** Fensterscheiben liegen per Parallaxe ~25 cm hinter der Fassade (sichtbare Laibungen), Markisen über Ladenzeilen, rund 1900 Balkone mit Glasbrüstung.
- **Ego-Sicht bei Regen:** Tropfen auf der Frontscheibe, die bei Tempo nach oben laufen; zwei Scheibenwischer räumen ihren Bereich frei, danach füllt er sich wieder. Augenhöhe so, dass der Scheibenrahmen über dem Blick liegt.
- **Spiegel mit echtem Bild:** Innen- und Außenspiegel zeigen in der Ego-Sicht eine Rückansicht (kleines Render-Target, jedes 3. Bild; nicht auf Niedrig).
- **Reifen:** Lauffläche mit Längsrillen und Lamellen, Flanke mit Schriftzug „VOLTARA AERO-GRIP 275/30 ZR21“.
- **Schmutz:** Offroad-Fahrten verschmutzen Schweller und Flanken fleckig braun, Regen wäscht ihn ab.
- **Augen-Anpassung:** in Häuserschluchten stellt die Belichtung träge (~1,5 s) heller.
- **Bewegungsunschärfe** (Grafik Hoch, abschaltbar): ab ca. 160 km/h radial vom Bildrand, Mitte bleibt scharf.

## Technik (Realismus-Paket 6 – Schärfe, Ego-Sicht, Polizei)
- **Scharfes Bild:** dynamische Auflösung nie unter 80 %; reicht das nicht, werden nacheinander Umgebungsverdeckung/Gras, Fußgänger/Spiegel und Schatten abgeschaltet. Nachschärfen (Unsharp-Mask) auf Hoch; Filmkorn, Farbsäume und Bewegungsunschärfe sind standardmäßig aus (Einstellungen „Film-Look“, „Bewegungsunschärfe“). Niedrig rendert mit 1,25-facher Pixeldichte.
- **Lenkrad-Rückstellung:** losgelassen von 270° in ≈ 0,23 s (Fahrt) bzw. ≈ 0,3 s (Stand) mittig, ohne Überschwingen.
- **Ego-Sicht:** Augenhöhe 1,20 m – freie Sicht auf die Straße, Cockpit im unteren Drittel; Scheibenrahmen und Innenspiegel liegen oben, Lenkrad etwas kleiner/tiefer, schlanke Unterarme.
- **Festnahme mit Timer:** Berühren/Rammen allein reicht nicht. Erst wenn Polizei < 6 m dran ist und man < 25 km/h fährt (oder 3 Wagen < 9 m bei < 50 km/h), läuft der Timer: Leicht 7 s, Normal 5 s, Schwer 4,7 s, Extrem 4,4 s, Insane 4 s. Balken mit „FESTNAHME x,x s“, letzte Sekunde rot blinkend, Warnton + Vibration; freigekommen läuft er langsam zurück.
- **Geld pro Sekunde** während der Verfolgung (Leicht 6 €/s … Insane 80 €/s, +25 % je Fahndungsstern), sekündlich gutgeschrieben und auch beim Erwischtwerden behalten; Flucht gibt zusätzlich einen Bonus. Anzeige „+x €/s · Summe“ im HUD.
- **Fünf Stufen** (Leicht … Insane) mit unterschiedlicher Wagenzahl, Tempo, Rammfreude, Sperren-Takt, Nagelbändern (ab Schwer: platte Reifen 9 s), Hubschrauber (ab Extrem). Fahndungssterne schalten zusätzlich frei: ★★★ Einkesseln, ★★★★ Sperren + Nagelbänder + Verstärkung, ★★★★★ Hubschrauber. Stufe und Sterne im HUD.
- **Polizei-Optik:** LED-Lichtbalken mit 6 Segmenten (Doppelblitz, Lauflicht, Allblitz), Grillblitzer, blauer Lichtschein auf der Straße; getönte Scheiben mit zwei Beamten.
- **Verkehr:** getönte, durchsichtige Scheiben mit Fahrer, Sitzen und Kopfstützen.
- **Leistungstest** (Einstellungen): 15 s automatische Fahrt durch die Innenstadt, zeigt Ø-FPS, 1-%-Tief, Pixeldichte und ob das Ziel (iPad 60 / iPhone 30 FPS) erreicht ist.
- **Grafik Hoch:** Umgebungsverdeckung (GTAO, halbe Auflösung), weiche Schatten (PCF mit Radius, engerer Bereich am Auto), leichter Dunst. Bäume: rissige Borke mit Furchen, Querrissen und Moos, dichtere Kronen, Blätterflattern, Durchscheinen gegen die Sonne.

## Technik (Grafik-Paket – AAA-Look)
- **Boost-Flammen neu:** Kette aus kamera-zugewandten Flammen-Sprites je Düse (von hinten voll sichtbar) mit weißblauem Kern, blauen Stoßdiamanten und orange-roter, züngelnder Spitze; Länge wächst mit Tempo.
- **Fehler behoben (Grafik Hoch):** Durchsichtiges (Flammen, Partikel, Glas, Regen, Lichtschein) wird nicht mehr in die Umgebungsverdeckung gerechnet – vorher erschienen dort dunkle Kästen.
- **Echte Umgebungsspiegelung im Lack und auf den Felgen** (Mittel/Hoch): Würfelkamera am Auto, eine Seite pro Bild (keine Ruckler), danach vorgefiltert; 8-Bit-Würfel, damit die Sonnenscheibe nicht überläuft (sonst leeres Bild über Bloom).
- **Lichtstrahlen der Sonne** (Hoch): helle Himmelsbereiche zwischen Bäumen/Häusern werden zur Sonne hin verschmiert, abends warm-orange.
- Linsenreflex wird in Spiegel-/Würfelaufnahmen nicht mitgezeichnet.

## Technik (Verkehr & Fahrzeugdetails)
- **Viel dichterer Verkehr:** Niedrig 45 / Mittel 100 / Hoch 160 fahrende Autos (vorher 12/22/34) plus 40/90/140 geparkte. Neue Autos erscheinen bevorzugt auf Straßen rund um den Spieler (110–400 m, nicht im Blickfeld); ein Auto ohne freien Platz bleibt, wo es ist (vorher konnte es ohne Straße bleiben → Absturz).
- **Auto:** Fantasie-Kennzeichen vorn/hinten, Türfugen, versenkte Türgriffe, gelbe Keramik-Bremssättel.

## Technik (Umgebung – Gelände & Wasser)
- **Gelände:** Steilhänge werden automatisch felsig, Hangfüße erdig; großräumiges Rauschen gegen Kachelmuster, in der Ferne grober Texturmaßstab; trockene, gelbliche Wiesenflecken und satte Senken. Wiesen grüner, Waldboden nur unter dichtem Wald.
- **Gras** dichter und weiter sichtbar (Mittel 6500 Büschel/48 m, Hoch 13000/65 m).
- **Stadt bei Nacht:** Laternen werfen sichtbare, warme Lichtkegel auf Straße, Gehweg und Wiese (vorher wurden die Lichtflecken wegen falscher Hüllkugel nie gezeichnet).
- **Regen:** Pfützen auf Straßen (in Weltkoordinaten verteilt, füllen sich mit der Nässe) – dort spiegelglatt und dunkel; nasse Fahrbahn dunkler und stärker spiegelnd.
- **Fernkulisse:** zwei echte Gebirgsketten statt einer flachen Silhouette – bewaldete Vorberge und dahinter zerklüftetes Hochgebirge mit Schneegipfeln, Grate durch Licht sichtbar, bläulicher Dunst (Luftperspektive), Abendrot.
- **Wald:** Unterholz aus Farnen (fächerförmige Wedel) und bemoosten, umgestürzten Stämmen; Mischwald mit hell-, satt- und gelbgrünen Laubbäumen, vereinzelt Herbstlaub, blaugrünen bis dunklen Nadelbäumen.
- **Stadt:** Wassertanks auf Stelzen und Antennenmasten auf den Dächern, Leuchtreklamen an den Fassaden (Fantasie-Namen, nachts hell), Bushaltestellen mit Glas-Wartehäuschen und Haltestellenschild, Baustelle mit gelbem Turmdrehkran, Last am Seil und Bauzaun. Nachts verschwinden die Berge im Dunkel.
- **Wetter neu:** „Gewitter“ (Starkregen mit Wind, Blitze alle 2–7 s mit sichtbarem, gezacktem Blitzstrahl, Donner verzögert nach Entfernung) und „Schnee“ (taumelnde Flocken, Schnee liegt auf flachem Gelände, Hänge bleiben felsig, Gras verschwindet unter der Decke).
- **Himmel:** Mond mit Mondmeeren und Lichthof bei Nacht; ziehende Wolkenschatten auf dem Gelände bei Sonne/Bewölkung.
- **Tankstelle** an der Landstraße (Dach auf Stützen, Zapfsäulen, Shop mit Schaufenster, Preismast) und **Parkhaus** am Flugplatz (4 offene Decks, Stützen, Brüstungen, Treppenhaus, geparkte Autos) – beide mit Kollision.
- **Tageszeit „Ablauf“:** Tag (5 min) → Abend (1,5 min) → Nacht (3 min) → Tag, mit Hinweis.
- **Talnebel** über dem See: abends rosa, bei Nebel/Regen dichter, am Tag kaum.
- **Altbauten:** etwa die Hälfte der niedrigen Wohnhäuser als Gründerzeit-Bauten – warmer Putz, Stockwerksgesimse, Pilaster, Stuck-Fensterumrahmungen mit Sprossen, abwechselnd Dreiecksgiebel und gerade Verdachungen.
- **Physikalischer Himmel:** Rayleigh- und Mie-Streuung mit Luftmassen-Näherung (blau oben, heller Dunst am Horizont und um die Sonne, Rötung bei tiefer Sonne); Wetter mischt Richtung Grau.
- **Volumetrisch wirkende Wolken** (Grafik Hoch): 6 Schritte durch eine Wolkenschicht mit Lichtprobe zur Sonne – helle Ränder, dunkle Unterseiten, Himmelsfarbe abends.
- **Verkehrsautos neu modelliert:** Karosserie als glatte Loft-Fläche aus gerundeten Querschnitten (statt Kästen) mit Motorhaube, Gürtellinie, rund eingezogenen Enden und Radausschnitten; Glashaus mit Tumblehome und getönten Scheiben, lackierte A-/C-Säulen, dunkle B-Säule, Chromleiste. Limousine, Kompaktwagen und SUV mit eigenen Proportionen.
- **See:** Wassertiefe aus dem Höhenfeld → klares, türkises Flachwasser am Ufer, dunkel in der Tiefe; zweite gegenläufige Wellenlage, pulsierender Uferschaum, Tropfenringe bei Regen.

## Code-Aufbau

```
index.html            Markup der Oberfläche, Importmap (three.js per CDN)
css/style.css         gesamtes Styling (HUD, Touch-Knöpfe, Menüs, Garage)
js/main.js            Startpunkt: Ladebildschirm, Spiel erzeugen, Menü öffnen
js/config.js          Fahrzeug-Abstimmung (CONFIG), Grafikstufen, Einstellungen
js/input.js           Touch (Lenk-Schieber, Knöpfe, Multitouch), Neigen, Haptik, Querformat/Drehung
js/camera.js          Verfolger-, Motorhauben- und Cockpit-Kamera, Wisch-/Zoom-Gesten
js/world/street.js     Bordsteine, Kanaldeckel, Stadtmöbel, Fußgänger
js/hud.js             Tacho, Gang, Drehzahl, Boost/Flug-Leisten, Geld, Telemetrie
js/vehicle/vehicle.js Raycast-Fahrphysik, E-Motor + Getriebe, Boost, Fliegen
js/vehicle/carmodel.js 3D-Modell des Roadsters inkl. Innenraum, Düsen, Reifenspuren
js/world/noise.js     Zufall und Rauschen (deterministisch)
js/world/world.js     Gelände, Straßennetz, Stadt, Wald, See/Brücke, Kollisionen, umfallende Bäume
js/world/traffic.js   Verkehrs-KI und Verkehrsautos (Starrkörper nach Zusammenstoß)
js/environment.js     Tag/Nacht, Himmel, Licht, Nebel, Bloom; Minimap
js/fx.js              Partikel, Gras, Starrkörper
js/audio.js           Motor-/Reifen-/Wind-Ton, Sirenen mit Doppler, Musik
js/police.js          Spielstand (Geld) und Polizei-KI mit Hubschrauber
js/missions.js        14 Missionen mit Medaillen
js/garage.js          Upgrades, Optik, Ausstellungsraum
js/menu.js            Hauptmenü, Tutorial, dynamische Auflösung
js/weather.js         Wetter, Bergkulisse, Felsen/Büsche, Schilder/Leitpfosten, Sonnenreflex
js/game.js            Spielschleife (feste 120-Hz-Physik), Zusammenspiel aller Teile
js/ui.js              Einstellungen
tools/bundle.py       baut dist/roadster-escape.html (alles in einer Datei)
manifest.webmanifest, sw.js, icons/   Web-App (Home-Bildschirm, offline)
```
