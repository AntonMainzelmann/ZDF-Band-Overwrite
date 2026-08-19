// ZDF Band Overwrite — API & Data Enrichment Module
(() => {
  "use strict";

  const DEBUG = true;
  const log = (...args) => DEBUG && console.log("[zdf-api]", ...args);

  // Wie viele Empfehlungen maximal geladen werden (begrenzt GraphQL-Last).
  const MAX_ITEMS = 4;

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

  // Löst reco_ids.json über die Web-Accessible-Resource Schnittstelle auf und parst sie
  async function loadRecoIds() {
    try {
      const url = chrome.runtime.getURL("reco_ids.json");
      log("Lade reco_ids.json von:", url);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP-Fehler beim Laden von reco_ids.json: ${response.status}`);
      }
      const data = await response.json();
      log("reco_ids.json erfolgreich geladen:", data);
      if (data && data.body && Array.isArray(data.body.predictions)) {
        return data.body.predictions.map(pred => pred[0]); // Gibt Array von IDs zurück
      }
      log("reco_ids.json hat ein ungültiges Format.");
      return [];
    } catch (e) {
      console.error("[zdf-api] Fehler beim Laden von reco_ids.json:", e);
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

  function toItem(id, v) {
    if (!v) {
      // ID existiert nicht in GraphQL (z.B. ARD-IDs) -> lokales Dummy-Fallback
      return {
        id, title: `Empfehlung: ${id.substring(0, 8)}`, href: `/suche?q=${id}`,
        image: FALLBACK_IMAGE, logo: null, channel: "ZDF", badges: [], subtitle: "Partner-Inhalt"
      };
    }
    const layouts = v.teaser?.imageWithoutLogo?.layouts;
    return {
      id: v.id || id,
      title: v.title || `Video ${id}`,
      href: v.canonical ? `/${v.canonical}` : `/id/${id}`,
      image: layouts?.dim1200X480 || layouts?.original || FALLBACK_IMAGE,
      logo: null,
      channel: "ZDF",
      badges: ["UT"],
      subtitle: v.subtitle || v.contentOwner?.title || ""
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
        contentOwner {
          title
        }
      }
    }
  `;

  // Fragt alle IDs in einem einzigen GraphQL-Request ab (statt einer Anfrage pro ID).
  async function fetchDebugItems() {
    const token = getCachedToken();
    if (!token) {
      log("Fehler: Kein API-Token gefunden. Breche ab.");
      return [];
    }

    const allIds = await loadRecoIds();
    if (allIds.length === 0) {
      log("Keine IDs in reco_ids.json gefunden oder Datei fehlerhaft. Breche ab.");
      return [];
    }

    const ids = allIds.slice(0, MAX_ITEMS);
    log(`Lade ${ids.length} von ${allIds.length} IDs gebatcht (ein Request) aus der ZDF-GraphQL-API...`);

    try {
      const data = await fetchGraphQL(GQL_VIDEOS_BY_IDS, { ids }, token);
      const byId = new Map((data?.videosByIds || []).filter(Boolean).map(v => [v.id, v]));
      const items = ids.map(id => toItem(id, byId.get(id)));
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
