# ZDF Band Overwrite (Debug)

Chrome-Erweiterung (Manifest V3) zum Debuggen von Teaser-Bändern und Empfehlungen auf zdf.de. Ersetzt konfigurierte Bänder mit Items aus eigenen SageMaker-Endpunkten, erzwingt A/B-Testgruppen und fragt die GraphQL-API direkt ab — alles ohne Backend-Zugriff, nur im Browser.

## Funktionen

- **Band-Overwrite** — konfigurierte Bänder (z. B. "Weiterschauen") werden mit Items aus einem SageMaker-Endpunkt überschrieben. Jedes Band hat einen eigenen An/Aus-Toggle im Popup, kein globaler Schalter mehr.
- **Next-Video-Override** — überschreibt die "nächstes Video"-Empfehlung im Player, ebenfalls per eigenem Toggle im Popup.
- **A/B-Gruppe setzen** — schreibt eine gewählte Testgruppe direkt in den `local-user-data`-localStorage-Eintrag von zdf.de und lädt die Seite neu.
- **GetJson** — feuert konfigurierte GraphQL-Queries gegen `api.zdf.de/graphql` (Token wird aus der Seite extrahiert) und zeigt das Ergebnis als Overlay auf der Seite.
- Toolbar-Icon zeigt per grünem Punkt an, ob mindestens ein Band oder Next-Video gerade aktiv überschreibt.

## Installation (Entwicklung)

```sh
npm install
npm run build
```

Danach in Chrome: `chrome://extensions` → Entwicklermodus aktivieren → **Entpackte Erweiterung laden** → `dist/` auswählen.

Nach jeder Code-Änderung `npm run build` erneut ausführen (oder `npm run watch` laufen lassen) und die Erweiterung in `chrome://extensions` neu laden.

## Scripts

| Befehl | Zweck |
| --- | --- |
| `npm run build` | Baut `src/` einmalig nach `dist/` |
| `npm run watch` | Baut bei jeder Änderung automatisch neu |
| `npm run package` | Baut und packt `dist/` als `addon.zip` im Repo-Root (z. B. für einen Store-Upload) |

## Konfiguration

Über die Options-Seite (Popup → "Einstellungen"):

- **Endpunkte** — wiederverwendbare SageMaker-Endpunkte (URL + API-Key)
- **History-Presets** — benannte Listen von Video-IDs als History-Input für Endpunkte
- **Start** — Band-Konfigurationen: welches Band (Label), welcher Endpunkt, welche History
- **Seitentypen** — welche `*ByCanonical`-GraphQL-Felder welchen Seitentyp erkennen (steuert, welche JSON-Templates im Popup passend angezeigt werden)
- **JSON-Templates** — GraphQL-Queries für die GetJson-Funktion
- **A/B-Gruppe** — verfügbare Testgruppen (von `abgroup.zdf.de/test.json`) zur Auswahl im Popup

## Projektstruktur

```
src/        Quellcode der Erweiterung (Manifest, Background, Content-Scripts, Options-UI)
scripts/    Build-Script (esbuild, kopiert statische Dateien)
dist/       Build-Ausgabe — nicht eingecheckt, per npm run build erzeugen
```

## Changelog

- DKDI-Band-Overwrite hinzugefügt ("Das könnte Dich interessieren")
- Next-Video-Overwrite hinzugefügt
- A/B-Gruppen-Setter hinzugefügt
- Import/Export-Feature hinzugefügt (Konfiguration als JSON sichern/wiederherstellen, Options-Seite → Export/Import)

## Hinweis

Internes Debug-Werkzeug, kein offizielles ZDF-Produkt.
