// ZDF Toolkit — API & Data Enrichment Module
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
    return {
      title: item.title,
      href: item.sharingUrl,
      layouts: item.teaser?.imageWithoutLogo?.layouts || item.teaser?.image?.layouts
    };
  }

  // Kartengrid im Overlay ist minmax(210px,1fr) mit auto-fit — bei wenigen
  // Items pro Sektion strecken sich die Karten über die volle Breite (siehe
  // renderResults in quick_search.js), bei vielen bleiben sie ~210px. Bild
  // erst hier auflösen, wenn die tatsächliche Item-Zahl der Sektion bekannt
  // ist, statt pauschal die kleinste Variante zu laden (die wirkt bei
  // gestreckten Karten sonst verpixelt).
  function resolveSectionImages(items) {
    const big = items.length <= 4;
    return items.map(({ layouts, ...rest }) => ({
      ...rest,
      image: (big
        ? layouts?.dim760X340 || layouts?.dim380X170 || layouts?.dim276X155
        : layouts?.dim276X155 || layouts?.dim380X170) || null
    }));
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

  // Kinder-Suche: ZDFs Suche kennt keinen Server-Filter für Kinderinhalte. SearchFilters
  // hat nur contentOwner/fsk/language (per Fehlermeldungen des Servers ermittelt, echte
  // Introspektion ist aus), und contentOwner taugt nicht als Ersatz: der Suchindex enthält
  // auch ARD-Erwachsenencontent (tatort, tagesschau), während Kinderinhalte über ZDF, ARD
  // und KiKA verteilt sind. Verlässlich ist nur structuralMetadata.isChildrenContent — das
  // ZDFs eigene Such-Query aber nicht mitholt. Also eigene Query (kein Persisted Hash nötig,
  // beliebige Querytexte werden akzeptiert), großzügig viele Treffer holen und clientseitig
  // filtern. Bei generischen Wörtern ist rund die Hälfte der 200 Treffer Kinderinhalt,
  // der größere first-Wert kostet ~30ms gegenüber first:24.
  const KIDS_SEARCH_FIRST = 200;
  // canonical + smartCollection.canonical nur für den ZDFchen-Filter (siehe getZdfchenCatalog).
  const KIDS_ITEM_FIELDS = `title sharingUrl canonical
    structuralMetadata { isChildrenContent }
    teaser {
      imageWithoutLogo { layouts { dim276X155 dim380X170 dim760X340 } }
      image { layouts { dim276X155 dim380X170 dim760X340 } }
    }`;
  // Video / ISmartCollection (Interface über alle *SmartCollection-Typen) / MetaCollection
  // sind die drei Item-Typen, die die Suche liefert.
  const KIDS_SEARCH_QUERY = `
    query getKidsSearchResults($query: String!, $mode: SearchMode, $first: Int) {
      searchDocuments(query: $query, mode: $mode, first: $first) {
        results { item {
          __typename
          ... on Video { ${KIDS_ITEM_FIELDS} smartCollection { canonical } }
          ... on ISmartCollection { ${KIDS_ITEM_FIELDS} }
          ... on MetaCollection { ${KIDS_ITEM_FIELDS} }
        } }
      }
    }`;

  // ZDFchen (Vorschulbereich, zdf.de/zdfchen) hat in der Suche kein eigenes Merkmal: die
  // Sendungen liegen unter ganz normalen Pfaden (/animation/…, /serien/…), tragen dieselbe
  // contentOwner-ID wie der Rest von ZDFtivi und kein Vorschul-Flag — structuralMetadata hat
  // nur isChildrenContent und genre, metaPlatformBrand kommt in Suchtreffern leer zurück.
  // Der einzige verlässliche Katalog ist die /zdfchen-Seite selbst, und die ist serverseitig
  // gerendert: ein Fetch plus Regex über die Sendungs-Links reicht (derzeit 38 Collections).
  // Einmal pro Tab-Lebensdauer geholt.
  const AREA_LINK_RE = /"\/(?:animation|serien|filme|shows|magazine|reportagen|dokus|kinder|zdfchen)\/([a-z0-9-]+)"/g;
  const areaCanonicalsCache = {}; // Pfad -> Promise<string[]>
  function getAreaCanonicals(path) {
    if (!areaCanonicalsCache[path]) {
      areaCanonicalsCache[path] = fetch("https://www.zdf.de" + path)
        .then(res => res.text())
        .then(html => [...new Set([...html.matchAll(AREA_LINK_RE)].map(m => m[1]))])
        .catch(e => {
          log("Bereichs-Katalog fehlgeschlagen:", path, e.message);
          delete areaCanonicalsCache[path]; // nächster Versuch darf neu laden
          return [];
        });
    }
    return areaCanonicalsCache[path];
  }

  async function getZdfchenCatalog() {
    return new Set(await getAreaCanonicals("/zdfchen"));
  }

  // Kachelreihe einer Bereichsseite: die ersten Sendungen ihres Katalogs, in einem Rutsch
  // über Aliase geholt (~100ms für 24 Collections). Damit hat das Overlay in den
  // Kinderbereichen auch ohne Eingabe etwas zu zeigen.
  const AREA_TEASER_COUNT = 24;
  const AREA_TEASER_FIELDS = `title sharingUrl
    teaser {
      imageWithoutLogo { layouts { dim276X155 dim380X170 dim760X340 } }
      image { layouts { dim276X155 dim380X170 dim760X340 } }
    }`;
  const areaTeasersCache = {}; // Pfad -> Promise<items[]>
  function getAreaTeasers(path) {
    if (!areaTeasersCache[path]) {
      areaTeasersCache[path] = (async () => {
        const token = getCachedToken();
        const canonicals = (await getAreaCanonicals(path)).slice(0, AREA_TEASER_COUNT);
        if (!token || !canonicals.length) return [];
        const aliases = canonicals.map((canonical, i) =>
          `  t${i}: smartCollectionByCanonical(canonical: ${JSON.stringify(canonical)}) { ${AREA_TEASER_FIELDS} }`);
        const data = await fetchGraphQL(`query getAreaTeasers {\n${aliases.join("\n")}\n}`, {}, token);
        // Nicht jeder Link der Seite ist eine SmartCollection (z.B. Meta-Seiten) -> null raus.
        return resolveSectionImages(Object.values(data || {}).filter(Boolean).map(mapSearchItem));
      })().catch(e => {
        log("Bereichs-Kacheln fehlgeschlagen:", path, e.message);
        delete areaTeasersCache[path];
        return [];
      });
    }
    return areaTeasersCache[path];
  }
  // catalog: null = alle Kinderinhalte, Set von Collection-Canonicals = nur diese Sendungen
  // (Videos zählen über ihre smartCollection dazu).
  async function searchKidsVideos(query, topFirst, allFirst, catalog = null) {
    const token = getCachedToken();
    if (!token) return [];
    const inScope = (item) => item?.structuralMetadata?.isChildrenContent
      && (!catalog || catalog.has(item.smartCollection?.canonical) || catalog.has(item.canonical));
    const fetchMode = async (mode, want) => {
      const data = await fetchGraphQL(KIDS_SEARCH_QUERY, { query, mode, first: KIDS_SEARCH_FIRST }, token);
      const hits = (data?.searchDocuments?.results || [])
        .map(r => r.item)
        .filter(inScope)
        .slice(0, want);
      return resolveSectionImages(hits.map(mapSearchItem));
    };
    const [top, all] = await Promise.all([
      fetchMode("TOP_RESULTS", topFirst),
      fetchMode("ALL_RESULTS_EXCLUDING_TOP_RESULTS", allFirst + topFirst)
    ]);
    // ALL_RESULTS_EXCLUDING_TOP_RESULTS lässt ZDFs ungefilterte Top-Treffer weg, nicht
    // unsere kindergefilterten — die tauchen also sonst doppelt auf.
    const topHrefs = new Set(top.map(i => i.href));
    return [
      { label: "Top-Ergebnisse", items: top },
      { label: "Alle Ergebnisse", items: all.filter(i => !topHrefs.has(i.href)).slice(0, allFirst) }
    ];
  }

  // /suche zeigt zwei Reihen: "Top-Ergebnisse" (beste Treffer über alle Inhaltstypen)
  // und "Alle Ergebnisse" (breite Liste) — beide über denselben Endpunkt, nur der
  // mode-Parameter unterscheidet sie. Labels kommen bei dieser Query (anders als bei
  // SearchRecommendation) nicht vom Server mit, daher hier fest wie auf /suche benannt.
  async function searchVideos(query, { topFirst = 6, allFirst = 24, kidsOnly = false, zdfchenOnly = false } = {}) {
    if (!query) return [];
    try {
      if (zdfchenOnly) {
        // Katalog leer (Fetch fehlgeschlagen) -> lieber alle Kinderinhalte als gar nichts.
        const catalog = await getZdfchenCatalog();
        return await searchKidsVideos(query, topFirst, allFirst, catalog.size ? catalog : null);
      }
      if (kidsOnly) return await searchKidsVideos(query, topFirst, allFirst);
      const group = await getAbGroup();
      const [top, all] = await Promise.all([
        fetchPersistedQuery("getSearchResults", SEARCH_PERSISTED_HASH,
          { query, mode: "TOP_RESULTS", group, first: topFirst, after: null }),
        fetchPersistedQuery("getSearchResults", SEARCH_PERSISTED_HASH,
          { query, mode: "ALL_RESULTS_EXCLUDING_TOP_RESULTS", group, first: allFirst, after: null })
      ]);
      return [
        { label: "Top-Ergebnisse", items: resolveSectionImages((top?.searchDocuments?.results || []).map(r => mapSearchItem(r.item))) },
        { label: "Alle Ergebnisse", items: resolveSectionImages((all?.searchDocuments?.results || []).map(r => mapSearchItem(r.item))) }
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
      return { label: rec.clusterLabel || configuration, items: resolveSectionImages(rec.items.map(mapSearchItem)) };
    } catch (e) {
      log("Default-Empfehlungen fehlgeschlagen:", configuration, e.message);
      return null;
    }
  }

  async function getDefaultSections() {
    const sections = await Promise.all([
      fetchRecommendationSection("search-history", 12),
      fetchRecommendationSection("search-discover", 12)
    ]);
    return sections.filter(Boolean);
  }

  // Exportiere das API-Modul auf das globale window-Objekt für main.js
  window.zdfApi = {
    fetchDebugItems,
    fetchNextVideoOverride,
    searchVideos,
    getDefaultSections,
    getAreaTeasers
  };

})();
