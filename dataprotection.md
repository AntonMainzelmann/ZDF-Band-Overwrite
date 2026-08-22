# Datenschutzerklärung — ZDF Toolkit (Debug)

Stand: 2026-08-21

Diese Erklärung beschreibt, welche Daten die Chrome-Erweiterung „ZDF Toolkit (Debug)" verarbeitet.

## Zweck der Erweiterung

Internes Debug-Werkzeug zum Testen von Teaser-Bändern, Video-Empfehlungen und A/B-Testgruppen auf zdf.de. Kein offizielles ZDF-Produkt, keine öffentliche Distribution vorgesehen.

## Welche Daten werden verarbeitet

**Lokal gespeicherte Konfiguration** (`chrome.storage.local`, verbleibt ausschließlich im Browser des Nutzers):

- Von der Nutzerin/dem Nutzer eingetragene Endpunkt-URLs und API-Keys für eigene SageMaker-Endpunkte
- History-Presets (Video-IDs)
- Band-Konfigurationen, Seitentyp-Zuordnungen, GraphQL-Templates
- Ausgewählte A/B-Testgruppe

Diese Daten werden **nicht** an den Entwickler der Erweiterung oder sonstige Dritte übertragen. Sie verlassen den lokalen Browser-Speicher nur, wenn die Erweiterung im Auftrag der Nutzerin/des Nutzers Anfragen an selbst konfigurierte Endpunkte sendet (siehe unten).

**Von zdf.de-Seiten ausgelesen:**

- API-Token und Seitenkennung (Canonical), zur Laufzeit aus dem Seitenkontext extrahiert, um GraphQL-Testabfragen im Namen der eingeloggten Sitzung auszuführen
- `local-user-data`-Eintrag im localStorage von zdf.de, zum Setzen der A/B-Testgruppe

Diese Werte werden nur im Speicher gehalten und für die jeweilige Anfrage verwendet, nicht dauerhaft gespeichert oder exportiert.

## Netzwerkverbindungen

Die Erweiterung sendet Anfragen an:

- `api.zdf.de/graphql` — GraphQL-Testabfragen (mit aus der Seite extrahiertem Token)
- `abgroup.zdf.de` — Abruf verfügbarer A/B-Testgruppen
- vom Nutzer selbst konfigurierte SageMaker-Endpunkte — zum Abruf von Test-Empfehlungsdaten (inkl. des dort hinterlegten API-Keys)

Es findet keine Übertragung an Server des Entwicklers statt. Es werden keine Analytics-, Tracking- oder Werbedienste eingebunden.

## Keine Datenweitergabe

Es werden keine Daten verkauft, vermietet oder zu Werbezwecken an Dritte weitergegeben.

## Datenlöschung

Alle gespeicherten Daten können über die Options-Seite der Erweiterung eingesehen und gelöscht werden, oder durch Deinstallation der Erweiterung (löscht `chrome.storage.local` vollständig).

