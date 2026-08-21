// ZDF Band Overwrite — Background Script
// Popup (popup.html/js) ist die Bedienoberfläche: Toggle für Band-Overwrite +
// Liste der JSON-Templates. Hier laufen nur die Dinge, die DOM-Zugriff auf die
// Zielseite oder Fetches an fremde Hosts brauchen (CSP der Zielseite kann
// Content-Script-Fetches blockieren, siehe fetchJson unten).

function setBadge(isActive) {
  chrome.action.setBadgeText({ text: isActive ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: isActive ? "#FF6600" : "#777777" });
}

chrome.storage.local.get("isActive").then(({ isActive }) => setBadge(isActive !== false));

// Badge folgt dem isActive-Zustand, unabhängig davon wer ihn ändert (Popup).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.isActive) setBadge(changes.isActive.newValue !== false);
});

// Fetcht konfigurierte Empfehlungs-Endpunkte für Content-Scripts. Läuft im
// Service Worker statt im Content-Script, da die Ziel-Seite (zdf.de) per CSP
// Requests an fremde Hosts blockieren kann.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "fetchJson") return;

  (async () => {
    try {
      const headers = { "Content-Type": "application/json" };
      if (message.token) headers["x-api-key"] = message.token;
      const res = await fetch(message.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message.body)
      });
      if (!res.ok) {
        sendResponse({ error: `HTTP ${res.status}` });
        return;
      }
      sendResponse({ data: await res.json() });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();

  return true; // Hält den Message-Channel für die async Antwort offen.
});

// ---------- JSON-Templates: ausgelöst per Klick im Popup ----------

// Läuft im Seitenkontext (executeScript), analog zu getToken() in zdf_api.js.
function extractTokenInPage() {
  const scripts = [...document.querySelectorAll("script")];
  const tokenScript = scripts.find(s => s.textContent && s.textContent.includes("apiAuthToken"));
  if (!tokenScript) return null;
  const text = tokenScript.textContent;
  const match = text.match(/apiAuthToken\\\":\\\"([^"]+)\\/) || text.match(/apiAuthToken":"([^"]+)"/);
  return match ? match[1] : null;
}

function extractCanonicalFromUrl(url) {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] || "";
}

// Templates deklarieren ihre Variable unterschiedlich ($canonical, $id, ...) —
// erste deklarierte Variable bekommt den aus der URL extrahierten Wert, ein
// evtl. vorhandenes $first pauschal 1.
function buildVariables(query, value) {
  const declared = [...query.matchAll(/\$(\w+)\s*:/g)].map(m => m[1]);
  const variables = {};
  if (declared[0]) variables[declared[0]] = value;
  if (declared.includes("first")) variables.first = 1;
  return variables;
}

async function getTokenForTab(tabId) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: extractTokenInPage }).catch(() => [null]);
  return result?.result ?? null;
}

async function fetchGraphQLRaw(query, variables, token) {
  const res = await fetch("https://api.zdf.de/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://www.zdf.de", "api-auth": `Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.errors?.length) return null;
  return json.data;
}

// Kein bekannter Seitentyp passt -> per Introspection nach *ByCanonical-Feldern
// suchen, die wir noch nicht kennen, und den Treffer als neuen Seitentyp
// speichern. So "lernt" die Extension neue Seitentypen automatisch dazu, statt
// sie hart zu codieren. Bricht nur, wenn ZDF Introspection sperrt — dann bleibt
// der Typ schlicht unbekannt (kein Absturz, siehe Aufrufer).
async function learnNewPageType(canonical, token, existingPageTypes) {
  const introspection = await fetchGraphQLRaw(
    "query { __schema { queryType { fields { name args { name } } } } }", {}, token
  );
  const fields = introspection?.__schema?.queryType?.fields || [];
  const known = new Set(existingPageTypes.map(p => p.marker));
  const candidates = fields
    .filter(f => f.name.endsWith("ByCanonical") && f.args?.some(a => a.name === "canonical") && !known.has(f.name))
    .map(f => f.name);
  if (candidates.length === 0) return null;

  const query = `query ProbeNewPageType($canonical: String!) { ${candidates.map((f, i) => `n${i}: ${f}(canonical: $canonical) { __typename }`).join(" ")} }`;
  const data = await fetchGraphQLRaw(query, { canonical }, token);
  if (!data) return null;
  const hitIndex = candidates.findIndex((_, i) => data[`n${i}`] != null);
  if (hitIndex < 0) return null;

  const queryField = candidates[hitIndex];
  const name = data[`n${hitIndex}`]?.__typename || queryField;
  const newType = { id: crypto.randomUUID(), name, marker: queryField };

  const { pageTypes = [] } = await chrome.storage.local.get("pageTypes");
  if (!pageTypes.some(p => p.marker === queryField)) {
    await chrome.storage.local.set({ pageTypes: [...pageTypes, newType] });
  }
  return { pageTypeId: newType.id, pageTypeName: newType.name };
}

// Statt Seiteninhalt zu erraten: fragt direkt die API, ob $canonical für einen
// der konfigurierten Seitentyp-Felder (z.B. videoByCanonical) etwas liefert —
// alle Felder gebatcht in einer Query, welches Alias nicht null ist gewinnt.
async function probePageType(canonical, token, pageTypes) {
  if (!token) return { pageTypeId: null, pageTypeName: null };

  if (pageTypes.length > 0) {
    const query = `query ProbePageType($canonical: String!) { ${pageTypes.map((p, i) => `p${i}: ${p.marker}(canonical: $canonical) { __typename }`).join(" ")} }`;
    const data = await fetchGraphQLRaw(query, { canonical }, token);
    const hitIndex = data ? pageTypes.findIndex((_, i) => data[`p${i}`] != null) : -1;
    if (hitIndex >= 0) return { pageTypeId: pageTypes[hitIndex].id, pageTypeName: pageTypes[hitIndex].name };
  }

  const learned = await learnNewPageType(canonical, token, pageTypes).catch(() => null);
  return learned || { pageTypeId: null, pageTypeName: null };
}

async function detectPageType(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const canonical = extractCanonicalFromUrl(tab.url);
  const token = await getTokenForTab(tabId);
  const { pageTypes = [] } = await chrome.storage.local.get("pageTypes");
  return await probePageType(canonical, token, pageTypes);
}

async function runJsonTemplate(tpl, tab) {
  try {
    const canonical = extractCanonicalFromUrl(tab.url);
    const token = await getTokenForTab(tab.id);
    if (!token) throw new Error("Kein API-Token auf der Seite gefunden.");

    const { pageTypes = [] } = await chrome.storage.local.get("pageTypes");
    const { pageTypeName } = await probePageType(canonical, token, pageTypes);

    const res = await fetch("https://api.zdf.de/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://www.zdf.de", "api-auth": `Bearer ${token}` },
      body: JSON.stringify({ query: tpl.query, variables: buildVariables(tpl.query, canonical) })
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (json?.errors?.length) throw new Error(json.errors[0].message);

    await chrome.tabs.sendMessage(tab.id, { action: "showJsonOverlay", title: tpl.name, data: json.data, pageType: pageTypeName });
  } catch (e) {
    await chrome.tabs.sendMessage(tab.id, { action: "showJsonOverlay", title: tpl.name, error: e.message }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "runJsonTemplate") return;

  (async () => {
    const { jsonTemplates = [] } = await chrome.storage.local.get("jsonTemplates");
    const tpl = jsonTemplates.find(t => t.id === message.templateId);
    if (!tpl) { sendResponse({ error: "Template nicht gefunden" }); return; }
    const tab = await chrome.tabs.get(message.tabId);
    await runJsonTemplate(tpl, tab);
    sendResponse({ ok: true });
  })();

  return true;
});

// Popup fragt hiermit ab, welcher Seitentyp auf dem aktuellen Tab erkannt
// wurde, um die Template-Liste vorab zu filtern (siehe popup.js).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "detectPageType") return;

  detectPageType(message.tabId).then(sendResponse);
  return true;
});

// main.js meldet jede SPA-Navigation (siehe dortiger history.pushState-Hook).
// Kein Popup nötig dafür — läuft im Hintergrund mit, damit pageTypes über die
// Zeit automatisch neue Seitentypen gelernt bekommt, während man auf zdf.de
// herumklickt. Ergebnis wird nicht gebraucht, nur der Lern-Seiteneffekt in
// probePageType/learnNewPageType zählt.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.action !== "pageNavigated" || !sender.tab?.id) return;
  detectPageType(sender.tab.id).catch(() => {});
});
