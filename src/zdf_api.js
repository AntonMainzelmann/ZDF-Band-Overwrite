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

  // Lädt die Empfehlungs-IDs. Ohne konfigurierten Endpunkt: Fallback auf die
  // gebündelte reco_ids.json (Debug-Default). Mit Endpunkt: Fetch läuft über
  // background.js, da die Content-Script-Seite (CSP der Zielseite) fremde
  // Hosts blockieren kann.
  async function loadRecoIds(endpoint, apiToken, seedIds, maxItems) {
    try {
      let data;
      if (endpoint) {
        log("Lade Empfehlungs-IDs von konfiguriertem Endpunkt:", endpoint);
        const body = { body: { history: seedIds || [], n_items: maxItems }, contentType: "application/json" };
        const res = await chrome.runtime.sendMessage({ action: "fetchJson", url: endpoint, token: apiToken, body });
        if (!res || res.error) {
          throw new Error(res?.error || "Unbekannter Fehler beim Endpunkt-Fetch");
        }
        data = res.data;
      } else {
        const url = chrome.runtime.getURL("reco_ids.json");
        log("Kein Endpunkt konfiguriert, lade Default reco_ids.json von:", url);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP-Fehler beim Laden von reco_ids.json: ${response.status}`);
        }
        data = await response.json();
      }
      log("Empfehlungs-IDs erfolgreich geladen:", data);
      // Bundled reco_ids.json nutzt {body:{predictions}}, der Live-Endpunkt {result:{predictions}}.
      const predictions = data?.result?.predictions || data?.body?.predictions;
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
  // config: { endpoint?, apiToken?, maxItems? } — ohne endpoint wird die
  // gebündelte reco_ids.json als Debug-Default verwendet.
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

  // Exportiere das API-Modul auf das globale window-Objekt für main.js
  window.zdfApi = {
    fetchDebugItems
  };

})();
