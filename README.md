# ZDF Toolkit (Debug)

Chrome-Erweiterung (Manifest V3) zum Debuggen von Teaser-Bändern und Empfehlungen auf zdf.de. Ersetzt konfigurierte Bänder mit Items aus eigenen SageMaker-Endpunkten, erzwingt A/B-Testgruppen und fragt die GraphQL-API direkt ab — alles ohne Backend-Zugriff, nur im Browser.

## Funktionen

- **Band-Overwrite** — konfigurierte Bänder (z. B. "Weiterschauen") werden mit Items aus einem SageMaker-Endpunkt überschrieben. Jedes Band hat einen eigenen An/Aus-Toggle im Popup, kein globaler Schalter mehr.
- **Next-Video-Override** — überschreibt die "nächstes Video"-Empfehlung im Player, ebenfalls per eigenem Toggle im Popup.
- **A/B-Gruppe setzen** — schreibt eine gewählte Testgruppe direkt in den `local-user-data`-localStorage-Eintrag von zdf.de und lädt die Seite neu.
- **GetJson** — feuert konfigurierte GraphQL-Queries gegen `api.zdf.de/graphql` (Token wird aus der Seite extrahiert) und zeigt das Ergebnis als Overlay auf der Seite.
- **Quick Search** — Spotlight-artiges Overlay statt der ZDF-Suchseite (Klick auf "Suche" oder Ctrl+Space). Live-Ergebnisse über dieselbe GraphQL-Suche wie `/suche`, vor der Eingabe dieselben Bänder (Meistgefunden, Kategorien, Entdecken). Auf `zdf.de/kinder` sucht es ausschließlich in Kinderinhalten, auf `zdf.de/zdfchen` nur im Vorschulkatalog — siehe [Kinder-Suche](#kinder-suche-zdfdekinder) und [ZDFchen-Suche](#zdfchen-suche-zdfdezdfchen).
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

## Kinder-Suche (zdf.de/kinder)

Wer auf `zdf.de/Kinder` die Suche öffnet, verlässt normalerweise den Kinderbereich und sucht global. Quick Search bleibt stattdessen im Kinderbereich: auf `/kinder*` liefert das Overlay nur Kinderinhalte, Placeholder "ZDF/kinder durchsuchen…".

### Warum kein Server-Filter

Das Schema von `api.zdf.de/graphql` wurde per Validierungsfehler abgeklopft (echte Introspection ist in Produktion deaktiviert — unbekanntes Argument/Feld schicken, der Server nennt in der Fehlermeldung den erwarteten Typ). Ergebnis:

- `searchDocuments` kennt die Argumente `query`, `mode`, `group`, `first`, `after`, `filters`.
- `filters` ist vom Typ `SearchFilters` und hat **nur** `contentOwner` (String), `fsk` (`SearchFiltersFskOption`) und `language` (`SearchFiltersLanguageOptions`). **Kein** Feld für Kinderinhalte.

Die naheliegenden Ersatzfilter tragen nicht:

- **`contentOwner`** — der Suchindex enthält den kompletten ARD-Erwachsenenkatalog, nicht nur ARD-Kinder. Stichprobe über je ~40 Treffer: "tatort" → 27× `ARD` (kein Kinderinhalt), "tagesschau" → 39× `ARD`. Gleichzeitig verteilen sich Kinderinhalte über mehrere Owner: "feuerwehrmann" → 35× `KiKA`, "maus" → 28× `ARD` + 5× `ZDF`. Ein Owner-Filter würde also ARD- und KiKA-Kinderinhalte ausschließen oder ARD-Erwachsenencontent reinlassen.
- **`fsk`/Altersgrenze** — trifft massenhaft Dokus, Sport und Nachrichten, die ohne Altersbeschränkung laufen, aber kein Kinderprogramm sind.

### Was stattdessen funktioniert

Zuverlässig ist `structuralMetadata.isChildrenContent`. Das Feld existiert auf allen drei Item-Typen, die die Suche liefert — `Video`, `ISmartCollection` (Interface über alle `*SmartCollection`-Typen) und `MetaCollection` — nur holt ZDFs eigene Such-Query es nicht mit. Da der Endpunkt beliebige Query-Texte akzeptiert (kein Persisted-Query-Hash nötig), stellt `searchKidsVideos()` in [src/zdf_api.js](src/zdf_api.js) eine eigene Query mit dem Feld:

```graphql
query getKidsSearchResults($query: String!, $mode: SearchMode, $first: Int) {
  searchDocuments(query: $query, mode: $mode, first: $first) {
    results { item {
      __typename
      ... on Video { title sharingUrl structuralMetadata { isChildrenContent } teaser { … } }
      ... on ISmartCollection { … }
      ... on MetaCollection { … }
    } }
  }
}
```

Gefiltert wird clientseitig. Damit trotzdem ein volles Grid zusammenkommt, holt die Query `first: 200` statt der sonst üblichen 6/24 — bei generischen Wörtern ist rund die Hälfte der Treffer Kinderinhalt ("abenteuer": 90 von 194). Der größere `first`-Wert kostet ~30 ms (154 ms statt 122 ms gemessen).

### Details der Umsetzung

- **Erkennung**: `location.pathname.startsWith("/kinder")`, ausgewertet zum Suchzeitpunkt statt beim Laden — zdf.de navigiert als SPA, man kann also ohne Reload in den Kinderbereich wechseln.
- **Dedup**: `ALL_RESULTS_EXCLUDING_TOP_RESULTS` schließt ZDFs *ungefilterte* Top-Treffer aus, nicht unsere kindergefilterten. Ohne Nachbehandlung stünden Treffer doppelt im Overlay, deshalb wird "Alle Ergebnisse" gegen die Hrefs der Top-Ergebnisse gefiltert.
- **Ohne Eingabe**: das Overlay zeigt die jeweils andere Kinderwelt — auf `/kinder` die ZDFchen-Sendungen, auf `/zdfchen` das große ZDFtivi-Angebot (siehe [Startansicht](#startansicht-ohne-eingabe)). Die Standardbänder von `/suche` fallen hier aus: Meistgefunden/Entdecken kommen aus ZDFs Empfehlungs-Query, die keinen Kinderfilter kennt, und Kategorie-Kacheln als Ersatz gibt es nicht — außer `/kinder` und `/kinder/sendungen-a-z` liefern die geprüften Kinder-Rubriken 404.

### Bekannte Grenzen

- Der Filter ist so gut wie ZDFs Metadatum: was nicht `isChildrenContent: true` gesetzt hat, taucht nicht auf.
- Bei sehr breiten Suchwörtern können die 200 geholten Treffer knapp werden — es gibt keine Nachladeschleife über den Cursor.
- Kein manueller Umschalter: außerhalb von `/kinder` sucht das Overlay unverändert global.
- Der Modus hängt am Pfad: klickt man ein Ergebnis an, landet man unter `/video/…` oder `/animation/…` und die nächste Suche ist wieder global.

## ZDFchen-Suche (zdf.de/zdfchen)

`zdf.de/zdfchen` ist der Vorschulbereich (Kinder bis 6 Jahre) und ein deutlich engerer Katalog als `/kinder`. Auf `/zdfchen*` liefert Quick Search nur Treffer aus diesem Katalog, Placeholder "ZDFchen durchsuchen…". Der Kinderfilter aus der [Kinder-Suche](#kinder-suche-zdfdekinder) reicht dafür nicht: "maus" bringt dort auch Grundschul- und ARD-Kinderinhalte, im ZDFchen-Modus nur Vorschulsendungen (Sam & Julia im Mäusehaus, Pip und Posy, Lenas Hof, Löwenzähnchen …), und "tatort" bringt null Treffer.

### Warum es dafür kein Metadatum gibt

ZDFchen ist in den Suchdaten unsichtbar:

- Die Sendungen liegen unter ganz normalen Pfaden (`/animation/meine-freundin-conni-102`, `/serien/rudis-rasselbande-108`), nicht unter `/zdfchen/…`.
- `contentOwner` ist derselbe wie beim restlichen ZDFtivi-Angebot (ID `3176e61d-…`, Titel "ZDF"), dazu kommen KiKA-Collections.
- `structuralMetadata` hat auf `Video` und `ISmartCollection` nur `isChildrenContent` und `genre` (plus `contentFamily`, `genreMetaCollection`, `publicationFormMetaCollection`) — kein Vorschul- oder Altersmerkmal. `genre` ist bei Vorschulserien schlicht "Abenteuer".
- `metaPlatformBrand` (das Feld, das ZDFs eigenes Frontend für Markenzuordnung mitholt) kommt in Suchtreffern leer zurück.
- Auch der Empfehlungs-Filtertyp `Filters` hilft nicht: er hat `onlyChildrenContent`, `contentOwner`, `fsk`, `language` — wieder nichts Vorschulspezifisches. (Die ZDFchen-Seite selbst nutzt ihn mit `onlyChildrenContent: true` plus einer eigenen Cluster-Konfiguration `dkdi-trending-fallback-zdfchen`.)

### Was stattdessen funktioniert

Der Katalog steht auf der Seite selbst. `zdf.de/zdfchen` ist serverseitig gerendert, also reicht ein Fetch plus Regex über die Sendungs-Links, um die Collection-Canonicals einzusammeln (derzeit 38 Stück, ZDF- und KiKA-Vorschulcollections). `getZdfchenCatalog()` in [src/zdf_api.js](src/zdf_api.js) holt das einmal pro Tab und cacht es im Speicher.

Gesucht wird dann wie im Kindermodus (`first: 200`, Filter auf `isChildrenContent`), zusätzlich muss der Treffer zum Katalog gehören:

- `ISmartCollection`/`MetaCollection`: eigener `canonical` liegt im Katalog.
- `Video`: `smartCollection.canonical` liegt im Katalog — so zählen alle Folgen einer ZDFchen-Sendung mit, ohne sie einzeln zu kennen.

Trefferzahlen aus je 200 geholten Ergebnissen: "conni" 9, "wickie" 62, "biene" 96, "maus" 21, "tatort" 0.

Schlägt der Katalog-Fetch fehl, fällt der Modus auf den normalen Kinderfilter zurück statt ein leeres Overlay zu zeigen.

### Startansicht (ohne Eingabe)

Beide Kindermodi zeigen vor der ersten Eingabe die **jeweils andere** Kinderwelt als Kachelreihe: auf `/kinder` den ZDFchen-Vorschulbereich, auf `/zdfchen` das große ZDFtivi-Angebot. Die eigene Startseite steht ja schon sichtbar hinter dem Overlay — so wird der Leerlauf zum Sprungbrett in den anderen Bereich.

Technisch ist das derselbe Katalog-Trick wie beim ZDFchen-Filter: `getAreaCanonicals(path)` zieht die Sendungs-Canonicals aus dem HTML der Bereichsseite, `getAreaTeasers(path)` holt für die ersten 24 davon Titel und Teaserbild in **einem** GraphQL-Request per Alias (`t0: smartCollectionByCanonical(canonical: "…") { … }`, ~100 ms für 24 Collections). Beides wird pro Pfad im Speicher gecacht, der Katalog-Fetch also von Filter und Kachelreihe geteilt.

### Bekannte Grenzen

- Der Katalog ist eine Momentaufnahme der `/zdfchen`-Seite: nimmt ZDF eine Sendung neu auf, taucht sie erst nach einem Tab-Reload in der Suche auf.
- Gefunden wird nur, was ZDFs Suche unter den ersten 200 Treffern liefert — bei sehr breiten Wörtern kann ein ZDFchen-Titel dahinter liegen und damit rausfallen.
- Der Regex hängt daran, dass `/zdfchen` seine Sendungen serverseitig als Links rendert. Baut ZDF die Seite auf reines Client-Rendering um, bleibt der Katalog leer und der Modus fällt auf den Kinderfilter zurück.
- Die Startansicht zeigt die ersten 24 Sendungen in der Reihenfolge der Bereichsseite, keine Empfehlung und keine Kategorie-Struktur.
- Beim ersten Öffnen im Kinderbereich lädt die Kachelreihe kurz (HTML-Fetch der anderen Bereichsseite plus ein GraphQL-Request); danach kommt sie aus dem Cache. Der Prefetch für die normale Startansicht deckt sie nicht ab.

## Projektstruktur

```
src/        Quellcode der Erweiterung (Manifest, Background, Content-Scripts, Options-UI)
scripts/    Build-Script (esbuild, kopiert statische Dateien)
dist/       Build-Ausgabe — nicht eingecheckt, per npm run build erzeugen
```

## Changelog

- Quick Search zeigt in den Kinderbereichen ohne Eingabe die jeweils andere Kinderwelt als Kachelreihe (`/kinder` → ZDFchen, `/zdfchen` → ZDFtivi)
- Quick Search sucht auf `zdf.de/zdfchen` nur noch im Vorschulkatalog (Katalog aus der `/zdfchen`-Seite, Filter über die Collection-Canonicals — siehe [ZDFchen-Suche](#zdfchen-suche-zdfdezdfchen))
- Quick Search sucht auf `zdf.de/kinder` nur noch in Kinderinhalten (eigene GraphQL-Query mit `structuralMetadata.isChildrenContent`, clientseitiger Filter — siehe [Kinder-Suche](#kinder-suche-zdfdekinder))
- Quick Search hinzugefügt (Overlay statt `/suche`, Ctrl+Space)
- Tracking Enhancer hinzugefügt (misst per IntersectionObserver, welche Teaser wirklich sichtbar waren, und schickt `defeatedAssetIds` als sendBeacon an tracksrv.zdf.de — Popup-Toggle, Default aus)
- DKDI-Band-Overwrite hinzugefügt ("Das könnte Dich interessieren")
- Next-Video-Overwrite hinzugefügt
- A/B-Gruppen-Setter hinzugefügt
- Import/Export-Feature hinzugefügt (Konfiguration als JSON sichern/wiederherstellen, Options-Seite → Export/Import)

## Hinweis

Internes Debug-Werkzeug, kein offizielles ZDF-Produkt.
