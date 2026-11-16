# Roadster Escape

Ein 3D-Fahrspiel für den Browser, gebaut für iPhone und iPad (Touch, Querformat). Du fährst einen elektrischen Hypercar-Roadster durch eine offene Welt: Stadt, Wald, Hügel, See und Rampen.

## Features
- Realistische Fahrphysik: Federung, Grip, Driften (Bremse + Lenken), Gewichtsverlagerung
- Boost und Fliegen, Landen auf Hausdächern
- Optionale Handschaltung mit 6 Gängen, Drehzahlanzeige und Schaltknöpfen ▲ ▼
- Bäume, die beim Anfahren realistisch umfallen, verschwinden und später nachwachsen
- Verkehr, den man richtig wegschubsen kann (ohne Schadensmodell)
- Polizei-Flucht mit fliegenden SUVs inklusive Blaulicht und Sirene, in den Stufen Normal, Schwer, Extreme und Insane
- 12 Missionen mit Medaillen (Bronze, Silber, Gold), die nach und nach freigeschaltet werden
- Garage: Leistungs-Upgrades, Lack, Felgen, Unterbodenlicht, Spoiler, Interieur und Ambientelicht
- Tag und Nacht, mit Scheinwerfern, Straßenlaternen und beleuchteten Fenstern
- Cockpit- und Verfolger-Kamera; Drehen durch Wischen, Zoomen mit zwei Fingern
- Speicherstand im Browser (localStorage)

## Spielen
`index.html` im Browser öffnen. Das Spiel braucht Internet, weil three.js vom CDN geladen wird.

### Online stellen mit GitHub Pages
1. Im Repository auf **Settings → Pages** gehen.
2. Bei *Source* **Deploy from a branch** wählen, dann den Branch `main` und den Ordner `/ (root)`, und auf **Save** tippen.
3. Nach ungefähr einer Minute läuft das Spiel unter `https://<benutzername>.github.io/roadster-escape/`.
4. Auf dem iPad in Safari: **Teilen → Zum Home-Bildschirm**. Dann startet das Spiel wie eine App im Vollbild.

## Steuerung
| Touch | Tastatur (PC) |
|---|---|
| Joystick links: lenken | Pfeiltasten / WASD |
| GAS / BREMSE | ↑ / ↓ |
| BOOST | Leertaste / Shift |
| FLIEGEN (halten) | F |
| Joystick nach unten (im Flug): sinken | X |
| ▲ / ▼ Gang (Handschaltung) | E / Q |
| 🎥 Kamera | C |
