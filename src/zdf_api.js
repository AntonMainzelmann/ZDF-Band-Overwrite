// ZDF Band Overwrite — API & Data Enrichment Module
(() => {
  "use strict";

  const DEBUG = true;
  const log = (...args) => DEBUG && console.log("[zdf-api]", ...args);

  const DEFAULT_MAX_ITEMS = 4;

  let cachedToken = null;

  // Extrahiert das apiAuthToken aus dem ZDF-DOM (analog zu use_graphql.js)
  function getToken() {
    const scripts = [...document.querySelectorAll('script')];
    const tokenScript = scripts.find(s =>
      s.textContent && s.textContent.includes('apiAuthToken')
    );

    if (!tokenScript) {
      log("Token-Script nicht gefunden!");
      return null;
    }

    const text = tokenScript.textContent;
    
    // Versuche verschiedene Matcher für apiAuthToken
    // 1. Der originale Matcher aus use_graphql.js
    let match = text.match(/apiAuthToken\\\":\\\"([^\\"]+)/);
    if (match) {
      const token = match[1];
      log("✅ Token über originalen Matcher gefunden:", token);
      return token;
    }
    
    // 2. Ein flexiblerer Matcher für unescapte oder andere Varianten
    match = text.match(/apiAuthToken":"([^"]+)"/) || 
            text.match(/apiAuthToken":"([^"\\]+)/) || 
            text.match(/apiAuthToken\\*":\\*"([^"]+)/);
    if (match) {
      const token = match[1];
      log("✅ Token über flexiblen Matcher gefunden:", token);
      return token;
    }

    log("Token im Script-Text nicht per Regex gefunden!");
    return null;
  }

  function getCachedToken() {
    if (cachedToken) return cachedToken;
    cachedToken = getToken();
    return cachedToken;
  }

  const FALLBACK_AB_GROUP = "gruppe-e";
  let cachedAbGroupPromise = null;

  // Liest die tatsächlich gesetzte A/B-Testgruppe statt sie hart zu codieren
  // (siehe background.js readAbGroupInPage — dieselbe Quelle wie Popup/Options).
  async function getAbGroup() {
    if (!cachedAbGroupPromise) {
      cachedAbGroupPromise = chrome.runtime.sendMessage({ action: "getAbGroup" })
        .then(res => res?.group || FALLBACK_AB_GROUP)
        .catch(() => FALLBACK_AB_GROUP);
    }
    return cachedAbGroupPromise;
  }

  // Lädt die Empfehlungs-IDs vom konfigurierten SageMaker-Endpunkt. Fetch läuft
  // über background.js, da die Content-Script-Seite (CSP der Zielseite) fremde
  // Hosts blockieren kann. Ohne Endpunkt: keine Items (state.js filtert Configs
  // ohne nutzbaren Endpunkt eh schon vorher raus, siehe isEndpointUsable).
  async function loadRecoIds(endpoint, apiToken, seedIds, maxItems) {
    if (!endpoint) return [];
    try {
      log("Lade Empfehlungs-IDs von konfiguriertem Endpunkt:", endpoint);
      const body = { body: { history: seedIds || [], n_items: maxItems }, contentType: "application/json" };
      const res = await chrome.runtime.sendMessage({ action: "fetchJson", url: endpoint, token: apiToken, body });
      if (!res || res.error) {
        throw new Error(res?.error || "Unbekannter Fehler beim Endpunkt-Fetch");
      }
      log("Empfehlungs-IDs erfolgreich geladen:", res.data);
      const predictions = res.data?.result?.predictions;
      if (Array.isArray(predictions)) {
        return predictions.map(pred => ({ id: pred[0], score: pred[1] }));
      }
      log("Antwort hat ein ungültiges Format.");
      return [];
    } catch (e) {
      console.error("[zdf-api] Fehler beim Laden der Empfehlungs-IDs:", e);
      return [];
    }
  }

  // Führt eine GraphQL-Query an ZDF.de aus
  async function fetchGraphQL(query, variables, token) {
    const response = await fetch("https://api.zdf.de/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://www.zdf.de",
        "api-auth": `Bearer ${token}`
      },
      body: JSON.stringify({ query, variables })
    });

    const json = await response.json().catch(() => null);

    if (!response.ok) {
      log("GraphQL-Fehlerantwort:", json);
      throw new Error(`GraphQL-Anfrage fehlgeschlagen mit HTTP ${response.status}: ${json?.errors?.[0]?.message || JSON.stringify(json)}`);
    }

    if (json.errors && json.errors.length > 0) {
      throw new Error(`GraphQL-Fehler: ${json.errors[0].message}`);
    }

    return json.data;
  }

  const FALLBACK_IMAGE = "https://www.zdf.de/assets/123-challenge-hero-100~1200x480?cb=1765189952318";

  function toItem(id, v, score) {
    if (!v) {
      // ID existiert nicht in GraphQL (z.B. ARD-IDs) -> lokales Dummy-Fallback
      return {
        id, title: `Empfehlung: ${id.substring(0, 8)}`, href: `/suche?q=${id}`,
        image: FALLBACK_IMAGE, logo: null, channel: "ZDF", badges: [], subtitle: "Partner-Inhalt", score
      };
    }
    const layouts = v.teaser?.imageWithoutLogo?.layouts;
    const logoLayouts = v.smartCollection?.logo?.layouts;
    return {
      id: v.id || id,
      title: v.title || `Video ${id}`,
      href: v.canonical ? `/${v.canonical}` : `/id/${id}`,
      image: layouts?.dim1200X480 || layouts?.original || FALLBACK_IMAGE,
      logo: logoLayouts?.dim760X340 || logoLayouts?.dim380X170 || null,
      channel: "ZDF",
      badges: ["UT"],
      subtitle: v.subtitle || v.contentOwner?.title || "",
      score
    };
  }

  // Offizielle Batch-Query des ZDF-Frontends: alle IDs in einem Request.
  const GQL_VIDEOS_BY_IDS = `
    query GetVideosByIds($ids: [String!]!) {
      videosByIds(ids: $ids) {
        id
        title
        canonical
        subtitle
        teaser {
          imageWithoutLogo {
            layouts {
              dim1200X480
              original
            }
          }
        }
        smartCollection {
          logo {
            layouts {
              dim380X170
              dim760X340
            }
          }
        }
        contentOwner {
          title
        }
      }
    }
  `;

  // Fragt alle IDs in einem einzigen GraphQL-Request ab (statt einer Anfrage pro ID).
  // config: { endpoint?, apiToken?, maxItems? } — ohne endpoint keine Items.
  async function fetchDebugItems(config = {}) {
    const { endpoint, apiToken, seedIds, maxItems = DEFAULT_MAX_ITEMS } = config;

    const token = getCachedToken();
    if (!token) {
      log("Fehler: Kein API-Token gefunden. Breche ab.");
      return [];
    }

    const allPredictions = await loadRecoIds(endpoint, apiToken, seedIds, maxItems);
    if (allPredictions.length === 0) {
      log("Keine Empfehlungs-IDs gefunden. Breche ab.");
      return [];
    }

    const predictions = allPredictions.slice(0, maxItems);
    const ids = predictions.map(p => p.id);
    log(`Lade ${ids.length} von ${allPredictions.length} IDs gebatcht (ein Request) aus der ZDF-GraphQL-API...`);

    try {
      const data = await fetchGraphQL(GQL_VIDEOS_BY_IDS, { ids }, token);
      const byId = new Map((data?.videosByIds || []).filter(Boolean).map(v => [v.id, v]));
      const items = predictions.map(p => toItem(p.id, byId.get(p.id), p.score));
      log(`Erfolgreich geladen: ${items.length} von ${ids.length} Items.`);
      return items;
    } catch (e) {
      log(`Batch-Query fehlgeschlagen: ${e.message}`);
      return [];
    }
  }

  // Für den Next-Video-Overwrite (siehe main.js/nextvideo_interceptor.js):
  // holt Empfehlungen und fragt sie mit genau der Feld-Selektion ab, die der
  // Player selbst angefragt hat, damit die Antwort strukturell exakt passt.
  // nextVideo() liefert kein Video direkt, sondern { recoId, clusterId,
  // configuration, items: [Video] } — bei request.itemsSelection wird dieser
  // Wrapper nachgebaut (Tracking-IDs sind für unsere Zwecke egal, nur die
  // Video-Liste zählt), sonst (request.singleSelection) einfach das Video.
  async function fetchNextVideoOverride(request, config = {}) {
    const { videoId, itemsSelection, singleSelection, scalarFields, varDefs, variables } = request;
    const { endpoint, apiToken, seedIds, maxItems = DEFAULT_MAX_ITEMS } = config;
    const perVideoSelection = itemsSelection || singleSelection;
    if (!perVideoSelection) return null;

    const token = getCachedToken();
    if (!token) return null;

    // Keine History konfiguriert -> aktuelles Video als History verwenden.
    const history = seedIds && seedIds.length ? seedIds : [videoId];
    const count = itemsSelection ? maxItems : 1;
    const predictions = await loadRecoIds(endpoint, apiToken, history, count);
    if (predictions.length === 0) return null;
    const ids = predictions.map(p => p.id);

    const overrideVarDefs = `(${[...(varDefs || []), "$__ids: [String!]!"].join(", ")})`;
    const query = `query NextVideoOverride${overrideVarDefs} { videosByIds(ids: $__ids) { ${perVideoSelection} } }`;
    try {
      const data = await fetchGraphQL(query, { ...variables, __ids: ids }, token);
      const byId = new Map((data?.videosByIds || []).filter(Boolean).map(v => [v.id, v]));
      const videos = ids.map(id => byId.get(id)).filter(Boolean);
      if (videos.length === 0) return null;

      if (!itemsSelection) return videos[0];

      const wrapper = {};
      for (const name of scalarFields) {
        wrapper[name] = name === "configuration"
          ? (variables?.configuration ?? variables?.input?.configuration ?? null)
          : crypto.randomUUID(); // recoId/clusterId etc.: reine Tracking-IDs, Wert egal
      }
      wrapper.items = videos;
      return wrapper;
    } catch (e) {
      log("Next-Video-Override fehlgeschlagen:", e.message);
      return null;
    }
  }

  // Persisted Queries der offiziellen ZDF-Suche (siehe /suche). Nur der Hash wird
  // gesendet, der volle Query-Text liegt server-seitig bereits vor (APQ) — bricht,
  // falls ZDF den Query-Text seines Frontends ändert und damit den Hash rotiert.
  const SEARCH_PERSISTED_HASH = "77f956f3dc8e9251075e16455d9bfdf24f68d035238497e4a75edea10b013322";
  const SEARCH_RECO_PERSISTED_HASH = "efed72c8e5b40fd0315a7729a62c6b6931c53ed257fb1860de36950c9ab65be9";

  function mapSearchItem(item) {
    // Karten im Overlay sind ~160px breit — dim276X155 (16:9, kleinste verfügbare
    // Layout-Variante) reicht auch auf Retina, dim380X170 wäre für die Kartengröße
    // unnötig groß und bremst beim gleichzeitigen Laden vieler Kacheln.
    const layouts = item.teaser?.imageWithoutLogo?.layouts || item.teaser?.image?.layouts;
    return {
      title: item.title,
      href: item.sharingUrl,
      image: layouts?.dim276X155 || layouts?.dim380X170 || null
    };
  }

  // Voller Query-Text statt Hash, per "Query automatisch finden" in den Quick-Search-
  // Einstellungen aus ZDFs Bundle gezogen (background.js findSearchQueriesInPage) —
  // überlebt eine Hash-Rotation, da kein Persisted-Query-Cache-Treffer nötig ist.
  async function getStoredQuery(operationName) {
    const { quickSearch } = await chrome.storage.local.get("quickSearch");
    return quickSearch?.queries?.[operationName] || null;
  }

  // content-type-Header wird nur gebraucht, damit Apollos CSRF-Check den
  // GET-Request akzeptiert (sonst 400 "potential CSRF").
  async function fetchPersistedQuery(operationName, hash, variables) {
    const token = getCachedToken();
    if (!token) return null;

    const storedQuery = await getStoredQuery(operationName);
    let res;
    if (storedQuery) {
      res = await fetch("https://api.zdf.de/graphql", {
        method: "POST",
        headers: { "api-auth": `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: storedQuery, variables })
      });
    } else {
      const extensions = { persistedQuery: { version: 1, sha256Hash: hash } };
      const url = `https://api.zdf.de/graphql?operationName=${operationName}`
        + `&variables=${encodeURIComponent(JSON.stringify(variables))}`
        + `&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
      res = await fetch(url, {
        headers: { "api-auth": `Bearer ${token}`, "accept": "application/json", "content-type": "application/json" }
      });
    }

    const json = await res.json();
    if (!res.ok || json.errors) {
      log(`${operationName} fehlgeschlagen:`, json.errors || res.status);
      return null;
    }
    return json.data;
  }

  // /suche zeigt zwei Reihen: "Top-Ergebnisse" (beste Treffer über alle Inhaltstypen)
  // und "Alle Ergebnisse" (breite Liste) — beide über denselben Endpunkt, nur der
  // mode-Parameter unterscheidet sie. Labels kommen bei dieser Query (anders als bei
  // SearchRecommendation) nicht vom Server mit, daher hier fest wie auf /suche benannt.
  async function searchVideos(query, { topFirst = 6, allFirst = 24 } = {}) {
    if (!query) return [];
    try {
      const group = await getAbGroup();
      const [top, all] = await Promise.all([
        fetchPersistedQuery("getSearchResults", SEARCH_PERSISTED_HASH,
          { query, mode: "TOP_RESULTS", group, first: topFirst, after: null }),
        fetchPersistedQuery("getSearchResults", SEARCH_PERSISTED_HASH,
          { query, mode: "ALL_RESULTS_EXCLUDING_TOP_RESULTS", group, first: allFirst, after: null })
      ]);
      return [
        { label: "Top-Ergebnisse", items: (top?.searchDocuments?.results || []).map(r => mapSearchItem(r.item)) },
        { label: "Alle Ergebnisse", items: (all?.searchDocuments?.results || []).map(r => mapSearchItem(r.item)) }
      ];
    } catch (e) {
      log("Suche fehlgeschlagen:", e.message);
      return [];
    }
  }

  // Die Kachelreihen, die /suche vor jeder Eingabe zeigt ("Meistgefunden" +
  // "Entdecken", per configuration unterschieden). Auch ohne echte
  // Wiedergabe-Historie liefert der Endpunkt ein generisches Ranking (getestet:
  // leere plays/views -> trotzdem volle, sinnvolle Ergebnisse).
  async function fetchRecommendationSection(configuration, first) {
    try {
      const abGroup = await getAbGroup();
      const data = await fetchPersistedQuery("SearchRecommendation", SEARCH_RECO_PERSISTED_HASH, {
        configuration,
        searchResultsHistory: [],
        input: {
          appId: "zdf-web-21f7c74d",
          filters: { contentOwner: [], fsk: [], language: [] },
          pagination: { first, after: null },
          usage: { history: { plays: [], views: [] } },
          user: { abGroup, userSegment: "segment_6" }
        }
      });
      const rec = data?.searchRecommendation;
      if (!rec) return null;
      return { label: rec.clusterLabel || configuration, items: rec.items.map(mapSearchItem) };
    } catch (e) {
      log("Default-Empfehlungen fehlgeschlagen:", configuration, e.message);
      return null;
    }
  }

  async function getDefaultSections() {
    const sections = await Promise.all([
      fetchRecommendationSection("search-history", 8),
      fetchRecommendationSection("search-discover", 12)
    ]);
    return sections.filter(Boolean);
  }

  // Exportiere das API-Modul auf das globale window-Objekt für main.js
  window.zdfApi = {
    fetchDebugItems,
    fetchNextVideoOverride,
    searchVideos,
    getDefaultSections
  };

})();
