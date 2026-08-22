// Datenmodell & Storage für die Options-Seite.
// Kanonisch: sagemakerEndpoints[] (wiederverwendbare SageMaker-Endpunkte) +
// historyPresets[] + configs[] (Band-Konfigurationen: Typ, Label, welcher
// Endpunkt, welche History, eigener Name, Max. Items). Für main.js/zdf_api.js
// wird daraus beim Speichern das alte flache Schema (bandConfigs/nextVideoConfig)
// abgeleitet — die Content-Scripts kennen das neue Schema nicht.

export const HOMEPAGE_LABELS = ["Weiterschauen", "Das könnte Dich interessieren", "Auch Interessant"];
export const TEST_CONNECTION_SEED_ID = "4c90e0a0-419e-400c-bc2d-cb94cac4d7da";

const DEFAULT_ENDPOINT_BASE = "https://sagemaker-gw.dev.zdf.hrnmtech.de/";
const DEFAULT_ENDPOINT_SUFFIXES = [
  "sasrec-coldstart-tv-mobile-pctablet",
  "sasrec-gbce-ppa-tv-mobile-pctablet",
  "sasrec-gbce-tv-mobile-pctablet"
];

// Nachschlage-Referenz für die Options-Seite (Copy-Paste-Vorlage, kein
// Default-Template mehr) — übernommen aus dem funktionierenden Bookmarklet
// (plugins/zdf-json-viewer.user.js). videoByCanonical mit $canonical (letztes
// URL-Pfadsegment), nicht das alte videoById/$id aus getjson.js, das keine
// Daten mehr lieferte.
const VIDEO_REFERENCE_QUERY = `
    query VideoByCanonical($canonical: String!, $first: Int) {
      videoByCanonical(canonical: $canonical) {
        id
        canonical
        recoModel
        contentType
        title
        sharingUrl
        leadParagraph
        editorialDate
        teaser {
          image {
            altText
            caption
            list
          }
        }
        contentOwner {
          title
          details
        }
        streamingOptions {
          ad
          ut
          dgs
          ov
          ks
          fsk
        }
        episodeInfo {
          episodeNumber
          seasonNumber
          hideEpisodeInformation
        }
        structuralMetadata {
          isChildrenContent
          genreInfo {
            original
            transformed
          }
          publicationFormInfo {
            original
            transformed
          }
          visualDimension {
            moods(first: $first) {
              nodes {
                mood
              }
            }
          }
        }
        smartCollection {
          id
          canonical
          title
          collectionType
          sharingUrl
          structuralMetadata {
            contentFamily
            publicationFormInfo {
              original
              transformed
            }
          }
        }
        seo {
          title
        }
        availability {
          fskBlocked
          vod {
            visible
            visibleFrom
            visibleTo
            fsk
          }
        }
        currentMediaType
        subtitle
        webUrl
        embeddingPossible
        publicationDate
        external {
          streamAnchorSourceUrl
          streamAnchorSourceUrlTemplate
        }
        currentMedia {
          nodes {
            ptmdTemplate
            ... on VodMedia {
              duration
              aspectRatio
              visible
              geoLocation
              highestVerticalResolution
              streamAnchorTags {
                nodes {
                  anchorOffset
                  anchorLabel
                }
              }
              skipIntro {
                startIntroTimeOffset
                stopIntroTimeOffset
                skipButtonDisplayTime
                skipButtonLabel
              }
              vodMediaType
              label
              contentType
            }
            ... on LiveMedia {
              geoLocation
              tvService
              title
              start
              stop
              editorialStart
              editorialStop
              encryption
              liveMediaType
              label
            }
            id
          }
        }
        tracking {
          nielsen
          zdf
          piano(filter: video)
        }
        nextEditorialVideo {
          id
          canonical
          recoModel
          contentType
          title
          sharingUrl
          leadParagraph
          editorialDate
          teaser {
            image {
              altText
              caption
              list
            }
          }
          contentOwner {
            title
            details
          }
          streamingOptions {
            ad
            ut
            dgs
            ov
            ks
            fsk
          }
          episodeInfo {
            episodeNumber
            seasonNumber
            hideEpisodeInformation
          }
          structuralMetadata {
            isChildrenContent
            genreInfo {
              original
              transformed
            }
            publicationFormInfo {
              original
              transformed
            }
            visualDimension {
              moods(first: $first) {
                nodes {
                  mood
                }
              }
            }
          }
          smartCollection {
            id
            canonical
            title
            collectionType
            sharingUrl
            structuralMetadata {
              contentFamily
              publicationFormInfo {
                original
                transformed
              }
            }
          }
          seo {
            title
          }
          availability {
            fskBlocked
            vod {
              visible
              visibleFrom
              visibleTo
              fsk
            }
          }
          currentMedia {
            nodes {
              ptmdTemplate
              ... on VodMedia {
                duration
              }
            }
          }
        }
      }
    }
  `;

// Nachschlage-Referenz für Collection-Seiten — nur Felder, die schon erprobt
// sind (identisch zur video.smartCollection-Teilauswahl oben, selber
// SmartCollection-Typ, also garantiert gültige Feldnamen). Kein vollständiges
// Schema, da wir smartCollectionByCanonical nie direkt introspektiert haben —
// bei Bedarf per Introspection-Query gegen api.zdf.de/graphql erweitern.
const COLLECTION_REFERENCE_QUERY = `
    query CollectionByCanonical($canonical: String!) {
      smartCollectionByCanonical(canonical: $canonical) {
        id
        canonical
        title
        collectionType
        sharingUrl
        structuralMetadata {
          contentFamily
          publicationFormInfo {
            original
            transformed
          }
        }
      }
    }
  `;

// Nachschlage-Referenz für Genre-/Themen-Seiten (z.B. /dokus) — Felder live
// gegen die API verifiziert (canonical einer MetaCollection ist ihre eigene
// ID, z.B. "pub-form-10003", NICHT der URL-Slug der Seite, siehe Kommentar
// bei KNOWN_CANONICAL_FIELDS in background.js).
const META_COLLECTION_REFERENCE_QUERY = `
    query MetaCollectionByCanonical($canonical: String!) {
      metaCollectionByCanonical(canonical: $canonical) {
        id
        canonical
        title
        metaType
        sharingUrl
        webUrl
        recoModel
        infoText
        visible
        structuralMetadata {
          isChildrenContent
          isNewsContent
          isSportContent
        }
        teaser {
          title
          description
          image {
            altText
            caption
            list
          }
        }
        seo {
          title
          description
          keywords
        }
        og {
          title
          description
          type
        }
      }
    }
  `;

export const QUERY_REFERENCE = [
  { name: "Video", query: VIDEO_REFERENCE_QUERY },
  { name: "Collection", query: COLLECTION_REFERENCE_QUERY },
  { name: "MetaCollection", query: META_COLLECTION_REFERENCE_QUERY }
];

const COMBINED_JSON_TEMPLATE_NAME = "Seite (Video + Collection)";
const COMBINED_JSON_TEMPLATE_QUERY = `
    query PageByCanonical($canonical: String!) {
      video: videoByCanonical(canonical: $canonical) {
        id
        canonical
        title
        contentType
        subtitle
        sharingUrl
      }
      collection: smartCollectionByCanonical(canonical: $canonical) {
        id
        canonical
        title
        collectionType
        sharingUrl
        structuralMetadata {
          contentFamily
          publicationFormInfo {
            original
            transformed
          }
        }
      }
    }
  `;

export function isEndpointUsable(ep) {
  return !!(ep && ep.apiKey && ep.apiKey.trim());
}

export let sagemakerEndpoints = [];
export let historyPresets = [];
export let configs = [];
export let jsonTemplates = [];
export let pageTypes = [];
export let abGroups = [];
export let abGroupMeta = { name: "", expirationDate: "" };

// Quick Search (main.js/quick_search.js) — eigener Storage-Key, unabhängig vom
// Band-Overwrite-Schema. Schreibt sofort bei jeder Änderung (kein Speichern-Button),
// quick_search.js reagiert live per chrome.storage.onChanged.
export const DEFAULT_QUICK_SEARCH = {
  enabled: true,
  interceptSearchClick: true,
  // Lädt Meistgefunden/Kategorien/Entdecken im Hintergrund vor (alle 5 Min. aufgefrischt),
  // damit das Overlay beim Öffnen sofort steht statt erst nachzuladen (siehe quick_search.js).
  preloadSearch: true,
  shortcut: { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: "Space" },
  // { getSearchResults?: string, SearchRecommendation?: string } — voller Query-Text statt
  // Persisted-Query-Hash, per "Query automatisch finden" aus ZDFs Bundle gezogen (siehe
  // background.js findSearchQueriesInPage). Leer = zdf_api.js nutzt die eingebauten Hashes.
  queries: {}
};
export let quickSearch = { ...DEFAULT_QUICK_SEARCH };

export async function setQuickSearch(patch) {
  quickSearch = { ...quickSearch, ...patch };
  await chrome.storage.local.set({ quickSearch });
}

const uid = () => crypto.randomUUID();

export const AB_GROUPS_SOURCE_URL = "https://abgroup.zdf.de/test.json";

export async function fetchAbGroups() {
  const res = await fetch(AB_GROUPS_SOURCE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data?.groups)) throw new Error("Unerwartetes Format (kein groups[]-Feld).");
  abGroups = data.groups;
  abGroupMeta = { name: data.name || "", expirationDate: data.expirationDate || "" };
  await chrome.storage.local.set({ abGroups, abGroupMeta });
  return abGroups;
}

export async function loadState() {
  const stored = await chrome.storage.local.get([
    "sagemakerEndpoints", "historyPresets", "configs", "jsonTemplates", "pageTypes",
    "abGroups", "abGroupMeta", "quickSearch",
    "endpoints", "combos", // Zwischenschema (Vorgänger-Iteration)
    "bandConfigs", "nextVideoConfig" // ursprüngliches flaches Schema
  ]);

  abGroups = stored.abGroups || [];
  abGroupMeta = stored.abGroupMeta || { name: "", expirationDate: "" };
  quickSearch = { ...DEFAULT_QUICK_SEARCH, ...(stored.quickSearch || {}) };

  // Nur bei komplett fehlendem Key vorbelegen — ein leeres Array bedeutet,
  // der User hat alle Einträge bewusst gelöscht, das bleibt so.
  const seedPageTypes = !stored.pageTypes;
  pageTypes = stored.pageTypes || [
    { id: uid(), name: "Video", marker: "videoByCanonical" },
    { id: uid(), name: "Collection", marker: "smartCollectionByCanonical" }
  ];

  // Kein Video-Einzeltemplate mehr vorbelegt — die volle Query dafür steht als
  // Copy-Paste-Referenz im JSON-Templates-Tab (QUERY_REFERENCE); nur die
  // Kombi-Query (deckt beide Seitentypen ab) bleibt als Startpunkt.
  const seedJsonTemplates = !stored.jsonTemplates;
  jsonTemplates = stored.jsonTemplates || [
    { id: uid(), name: COMBINED_JSON_TEMPLATE_NAME, query: COMBINED_JSON_TEMPLATE_QUERY, pageTypeId: null }
  ];

  if (stored.sagemakerEndpoints) {
    sagemakerEndpoints = stored.sagemakerEndpoints;
    historyPresets = stored.historyPresets || [];
    configs = stored.configs || [];
    if (seedJsonTemplates || seedPageTypes) await persist();
    return;
  }

  historyPresets = (stored.historyPresets || []).map(p => ({ id: uid(), ...p }));
  sagemakerEndpoints = [];
  configs = [];

  if (stored.endpoints) {
    // Migration aus dem Zwischenschema (endpoints[] + combos[]).
    for (const ep of stored.endpoints) {
      const sm = { id: ep.id, name: ep.name, url: ep.url, apiKey: ep.apiKey || "" };
      sagemakerEndpoints.push(sm);
      const epCombos = (stored.combos || []).filter(c => c.endpointId === ep.id);
      for (const c of epCombos) {
        configs.push({
          id: c.id, type: ep.type, label: ep.type === "homepage" ? ep.name : "Next-Video",
          name: ep.name, sagemakerEndpointId: sm.id, historyPresetId: c.historyPresetId,
          maxItems: ep.maxItems || 4, active: c.active
        });
      }
    }
  } else if ((stored.bandConfigs && stored.bandConfigs.length) || (stored.nextVideoConfig && stored.nextVideoConfig.endpoint)) {
    // Migration aus dem ursprünglichen flachen Schema (bandConfigs/nextVideoConfig).
    for (const band of stored.bandConfigs || []) {
      migrateFlat({ name: band.label, type: "homepage", label: band.label, url: band.endpoint,
                    apiKey: band.apiToken, maxItems: band.maxItems, seedIds: band.seedIds });
    }
    const nv = stored.nextVideoConfig;
    if (nv && nv.endpoint) {
      migrateFlat({ name: "Next-Video", type: "video", label: "Next-Video", url: nv.endpoint,
                    apiKey: nv.apiToken, maxItems: nv.maxItems, seedIds: nv.seedIds });
    }
  } else {
    // Frische Installation: die drei bekannten SageMaker-Endpunkte vorbelegen (ohne Key -> inaktiv).
    sagemakerEndpoints = DEFAULT_ENDPOINT_SUFFIXES.map(suffix => ({
      id: uid(), name: suffix, url: DEFAULT_ENDPOINT_BASE + suffix, apiKey: ""
    }));
  }

  await persist();
}

function migrateFlat({ name, type, label, url, apiKey, maxItems, seedIds }) {
  const sm = { id: uid(), name, url, apiKey: apiKey || "" };
  sagemakerEndpoints.push(sm);
  let historyPresetId = null;
  if (seedIds && seedIds.length) {
    const preset = { id: uid(), name: `${name} (migriert)`, ids: seedIds };
    historyPresets.push(preset);
    historyPresetId = preset.id;
  }
  configs.push({ id: uid(), type, label, name, sagemakerEndpointId: sm.id, historyPresetId,
                 maxItems: maxItems || 4, active: true });
}

async function persist() {
  await chrome.storage.local.set({ sagemakerEndpoints, historyPresets, configs, jsonTemplates, pageTypes });
}

function deriveLegacyConfig() {
  const bandConfigs = [];
  let nextVideoConfig = {};

  for (const c of configs.filter(c => c.active)) {
    const ep = sagemakerEndpoints.find(e => e.id === c.sagemakerEndpointId);
    if (!isEndpointUsable(ep)) continue; // kein Key hinterlegt -> zählt als inaktiv
    const preset = historyPresets.find(p => p.id === c.historyPresetId);
    const cfg = { endpoint: ep.url, apiToken: ep.apiKey, seedIds: preset ? preset.ids : [], maxItems: c.maxItems || 4 };
    if (c.type === "video") {
      if (!nextVideoConfig.endpoint) nextVideoConfig = cfg;
    } else {
      bandConfigs.push({ label: c.label, ...cfg });
    }
  }
  return { bandConfigs, nextVideoConfig };
}

// Nur Endpunkte werden hart validiert (blockieren Save überall, da sie
// Grundlage für alle Configs sind). Unvollständige Configs (kein Endpunkt,
// kein Key) blockieren nichts — sie werden beim Ableiten einfach übersprungen
// und in der UI als inaktiv/gewarnt angezeigt (siehe isEndpointUsable).
export function validate() {
  const errors = [];
  for (const ep of sagemakerEndpoints) {
    if (!ep.name.trim() || !ep.url.trim()) {
      errors.push(`Endpunkt "${ep.name || "(ohne Namen)"}": Name und URL sind Pflicht.`);
    }
  }
  return errors;
}

export async function save() {
  const errors = validate();
  if (errors.length) return { ok: false, errors };

  historyPresets = historyPresets.filter(p => p.name.trim() && p.ids.length);
  jsonTemplates = jsonTemplates.filter(t => t.name.trim() && t.query.trim());
  pageTypes = pageTypes.filter(p => p.name.trim() && p.marker.trim());
  const { bandConfigs, nextVideoConfig } = deriveLegacyConfig();
  await chrome.storage.local.set({ sagemakerEndpoints, historyPresets, configs, jsonTemplates, pageTypes, bandConfigs, nextVideoConfig });
  return { ok: true };
}

export function exportSnapshot() {
  return { version: 1, exportedAt: new Date().toISOString(), sagemakerEndpoints, historyPresets, configs, jsonTemplates, pageTypes };
}

export function importSnapshot(data) {
  if (!data || !Array.isArray(data.sagemakerEndpoints) || !Array.isArray(data.historyPresets) || !Array.isArray(data.configs)) {
    throw new Error("Ungültiges Format — erwarte sagemakerEndpoints[], historyPresets[], configs[].");
  }
  sagemakerEndpoints = data.sagemakerEndpoints;
  historyPresets = data.historyPresets;
  configs = data.configs;
  jsonTemplates = Array.isArray(data.jsonTemplates) ? data.jsonTemplates : [];
  pageTypes = Array.isArray(data.pageTypes) ? data.pageTypes : [];
}

export function addSagemakerEndpoint() {
  const ep = { id: uid(), name: "", url: "", apiKey: "" };
  sagemakerEndpoints.push(ep);
  return ep;
}

export function removeSagemakerEndpoint(id) {
  sagemakerEndpoints = sagemakerEndpoints.filter(e => e.id !== id);
  configs.forEach(c => { if (c.sagemakerEndpointId === id) c.sagemakerEndpointId = null; });
}

export function addJsonTemplate() {
  const t = { id: uid(), name: "", query: "", pageTypeId: null };
  jsonTemplates.push(t);
  return t;
}

export function removeJsonTemplate(id) {
  jsonTemplates = jsonTemplates.filter(t => t.id !== id);
}

export function addPageType() {
  const p = { id: uid(), name: "", marker: "" };
  pageTypes.push(p);
  return p;
}

export function removePageType(id) {
  pageTypes = pageTypes.filter(p => p.id !== id);
  jsonTemplates.forEach(t => { if (t.pageTypeId === id) t.pageTypeId = null; });
}

export function addHistoryPreset() {
  const p = { id: uid(), name: "", ids: [] };
  historyPresets.push(p);
  return p;
}

export function removeHistoryPreset(id) {
  historyPresets = historyPresets.filter(p => p.id !== id);
  configs.forEach(c => { if (c.historyPresetId === id) c.historyPresetId = null; });
}

export function addConfig() {
  const groupHasActive = configs.some(c => groupKey(c) === "homepage::" + HOMEPAGE_LABELS[0]);
  const c = { id: uid(), type: "homepage", label: HOMEPAGE_LABELS[0], name: "", sagemakerEndpointId: null,
              historyPresetId: null, maxItems: 4, active: !groupHasActive };
  configs.push(c);
  return c;
}

export function removeConfig(id) {
  configs = configs.filter(c => c.id !== id);
}

export function groupKey(c) {
  return c.type === "video" ? "video" : `homepage::${c.label}`;
}

export function setActiveConfig(id) {
  const target = configs.find(c => c.id === id);
  if (!target) return;
  const key = groupKey(target);
  configs.forEach(c => { if (groupKey(c) === key) c.active = (c.id === id); });
}

// Nach Typ-/Label-Änderungen kann eine Config in eine Gruppe rutschen, die
// schon einen aktiven Eintrag hat — dann bleibt nur der erste aktiv.
export function normalizeActiveGroups() {
  const seen = new Set();
  for (const c of configs) {
    if (!c.active) continue;
    const key = groupKey(c);
    if (seen.has(key)) c.active = false; else seen.add(key);
  }
}
