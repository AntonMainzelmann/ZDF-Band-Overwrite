// ZDF Band Overwrite — Background Script
// Popup (popup.html/js) ist die Bedienoberfläche: Toggle für Band-Overwrite +
// Liste der JSON-Templates. Hier laufen nur die Dinge, die DOM-Zugriff auf die
// Zielseite oder Fetches an fremde Hosts brauchen (CSP der Zielseite kann
// Content-Script-Fetches blockieren, siehe fetchJson unten).

const ICON_SIZES = ["16", "32", "48", "128"];
function iconPaths(name) {
  return Object.fromEntries(ICON_SIZES.map(sz => [sz, `icons/${name}-${sz}.png`]));
}

function setBadge(isActive) {
  chrome.action.setIcon({ path: iconPaths(isActive ? "m1_active" : "m1") })
    .catch(e => console.error("[badge] setIcon fehlgeschlagen:", e));
}

// Badge ist "an" sobald mind. ein Band überschreibt — kein globaler Schalter
// mehr, siehe popup.js.
const NEXT_VIDEO_KEY = "__nextVideo__"; // muss zu main.js/popup.js passen

// Bei mehreren schnell hintereinander getoggelten Einträgen laufen mehrere
// updateBadge()-Aufrufe parallel; ihre storage.get()-Promises können außer
// der Reihe auflösen. Token sorgt dafür, dass nur der zuletzt ausgelöste
// Aufruf das Icon setzen darf, ein überholter Aufruf sonst einen älteren
// Zustand über den aktuellen schreiben könnte.
let badgeToken = 0;
async function updateBadge() {
  const token = ++badgeToken;
  const { bandConfigs = [], bandActive = {}, nextVideoConfig } =
    await chrome.storage.local.get(["bandConfigs", "bandActive", "nextVideoConfig"]);
  if (token !== badgeToken) return;
  const anyBandActive = bandConfigs.some(c => bandActive[c.label] !== false);
  const nextVideoActive = !!nextVideoConfig?.endpoint && bandActive[NEXT_VIDEO_KEY] !== false;
  setBadge(anyBandActive || nextVideoActive);
}

updateBadge();

// Lädt bei Installation/Update die verfügbaren A/B-Testgruppen, damit die
// Options-Seite (A/B-Gruppe-Tab) sie sofort zur Auswahl anbieten kann, ohne
// dass der User erst manuell "neu laden" klicken muss.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const res = await fetch("https://abgroup.zdf.de/test.json");
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data?.groups)) {
      await chrome.storage.local.set({
        abGroups: data.groups,
        abGroupMeta: { name: data.name || "", expirationDate: data.expirationDate || "" }
      });
    }
  } catch {
    // Kein Netz o.ä. beim Install — Options-Seite bietet "Gruppen neu laden" als Fallback.
  }
});

// Badge folgt bandActive/bandConfigs, unabhängig davon wer sie ändert (Popup/Options).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.bandActive || changes.bandConfigs || changes.nextVideoConfig)) updateBadge();
});

// ---------- A/B-Gruppe: direktes Setzen im localStorage der Zielseite ----------
// zdf.de entscheidet die A/B-Testgruppe aus dem Zustand-Persist-Store im
// localStorage-Key "local-user-data" (state.abGroup = {name, expirationDate,
// group}), NICHT aus der URL. Popup schreibt hier direkt rein (echtes
// "Setzen", kein An/Aus-Override) und lädt die Seite danach neu.

function readAbGroupInPage() {
  try {
    const parsed = JSON.parse(localStorage.getItem("local-user-data") || "null");
    return parsed?.state?.abGroup?.group || null;
  } catch {
    return null;
  }
}

function writeAbGroupInPage(group, meta) {
  const STORAGE_KEY = "local-user-data";
  let parsed;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    parsed = raw ? JSON.parse(raw) : { state: {}, version: 1 };
  } catch {
    parsed = { state: {}, version: 1 };
  }
  parsed.state = parsed.state || {};
  parsed.state.abGroup = {
    expirationDate: meta?.expirationDate || parsed.state.abGroup?.expirationDate || "",
    name: meta?.name || parsed.state.abGroup?.name || "",
    group
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "getAbGroup") return;
  (async () => {
    // Popup hat keinen eigenen Tab-Kontext und schickt tabId explizit mit;
    // ein Content-Script (z.B. zdf_api.js) läuft schon im Ziel-Tab, dafür reicht sender.tab.
    const tabId = message.tabId ?? sender.tab?.id;
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: readAbGroupInPage }).catch(() => [null]);
    sendResponse({ group: result?.result ?? null });
  })();
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "setAbGroup") return;
  (async () => {
    const { abGroupMeta } = await chrome.storage.local.get("abGroupMeta");
    await chrome.scripting.executeScript({
      target: { tabId: message.tabId }, func: writeAbGroupInPage, args: [message.group, abGroupMeta || {}]
    }).catch(() => {});
    sendResponse({ ok: true });
  })();
  return true;
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

// Läuft im Seitenkontext, analog zu extractTokenInPage(). Next.js kann den
// URL-Slug serverseitig per Rewrite auf einen anderen Canonical-Wert
// umschreiben, bevor die Seite rendert (z.B. /dokus -> "pub-form-10003" bei
// MetaCollection-Seiten) — der URL-Slug ist dann für GraphQL-Probes nutzlos.
// Next.js kodiert das aufgelöste Routensegment im RSC-Hydration-Payload
// (self.__next_f.push(...), siehe DevTools "Elements" auf einer Seite mit
// Rewrite) als ["canonical","<wert>","d",[]] — Anführungszeichen können dort
// je nach Verschachtelungstiefe des umgebenden Strings escaped sein, daher
// \\? statt fixer Erwartung. Kein Treffer (z.B. Seiten ohne Rewrite) ->
// null, Aufrufer fällt auf extractCanonicalFromUrl() zurück.
function extractResolvedCanonicalInPage() {
  const scripts = [...document.querySelectorAll("script")];
  for (const s of scripts) {
    const text = s.textContent;
    if (!text || !text.includes("__next_f")) continue;
    const match = text.match(/\\?"canonical\\?",\\?"([^"\\]+)\\?",\\?"d\\?",\\?\[\\?\]\\?\]/);
    if (match) return match[1];
  }
  return null;
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

async function getCanonicalForTab(tabId, url) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: extractResolvedCanonicalInPage }).catch(() => [null]);
  return result?.result || extractCanonicalFromUrl(url);
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

// ZDF sperrt GraphQL-Introspection in Produktion (__schema liefert
// INTROSPECTION_DISABLED) — Kandidaten für neue Seitentypen kommen daher aus
// einer festen Liste bekannter *ByCanonical-Felder statt aus Schema-Abfrage.
// Per Hand gegen die API verifiziert (siehe Kommentar): videoByCanonical und
// smartCollectionByCanonical sind schon als Default-Seitentypen registriert,
// metaCollectionByCanonical existiert zusätzlich im Schema. Liste manuell
// erweitern, wenn ZDF ein neues *ByCanonical-Feld einführt.
const KNOWN_CANONICAL_FIELDS = ["videoByCanonical", "smartCollectionByCanonical", "metaCollectionByCanonical"];

// Kein bekannter Seitentyp passt -> Kandidaten aus KNOWN_CANONICAL_FIELDS
// durchprobieren und den Treffer als neuen Seitentyp speichern. So "lernt"
// die Extension neue Seitentypen automatisch dazu, statt sie hart zu codieren.
async function learnNewPageType(canonical, token, existingPageTypes) {
  const known = new Set(existingPageTypes.map(p => p.marker));
  const candidates = KNOWN_CANONICAL_FIELDS.filter(f => !known.has(f));
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
  const canonical = await getCanonicalForTab(tabId, tab.url);
  const token = await getTokenForTab(tabId);
  const { pageTypes = [] } = await chrome.storage.local.get("pageTypes");
  return await probePageType(canonical, token, pageTypes);
}

async function runJsonTemplate(tpl, tab) {
  try {
    const canonical = await getCanonicalForTab(tab.id, tab.url);
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

// ---------- Quick Search: Persisted-Query-Hashes können bei einem ZDF-Deploy
// rotieren (siehe zdf_api.js). "Query automatisch finden" holt sich statt eines
// Hashes gleich den vollen Query-Text aus ZDFs eigenem JS-Bundle (dort als
// bereits geparste GraphQL-AST eingebettet) und druckt ihn wieder zu Text —
// danach läuft die Suche wie main.js' videosByIds-Query mit vollem Query-Text
// statt Persisted-Query-Hash, ist also gegen Hash-Rotation immun.
// Läuft komplett im Seitenkontext (executeScript): Bundle-Fetches sind
// same-origin, brauchen keinen Umweg über den Service Worker.
function findSearchQueriesInPage() {
  const OPERATIONS = {
    getSearchResults: { query: "tatort", mode: "ALL_RESULTS_EXCLUDING_TOP_RESULTS", group: "gruppe-e", first: 3, after: null },
    SearchRecommendation: {
      configuration: "search-history", searchResultsHistory: [],
      input: {
        appId: "zdf-web-21f7c74d", filters: { contentOwner: [], fsk: [], language: [] },
        pagination: { first: 4, after: null }, usage: { history: { plays: [], views: [] } },
        user: { abGroup: "gruppe-e", userSegment: "segment_6" }
      }
    }
  };

  function extractBalanced(src, startBraceIdx) {
    let depth = 0, i = startBraceIdx;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '"') { i++; while (i < src.length && src[i] !== '"') { if (src[i] === "\\") i++; i++; } continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return src.slice(startBraceIdx, i + 1); }
    }
    return null;
  }

  function printDocument(ast) {
    const fragmentsByName = {};
    ast.definitions.forEach(d => { if (d.kind === "FragmentDefinition") fragmentsByName[d.name.value] = d; });
    const emptyFrags = new Set();
    const hasClient = (n) => (n.directives || []).some(d => d.name.value === "client");
    const join = (arr, sep = "") => (arr || []).filter(Boolean).join(sep);
    const wrap = (start, str, end = "") => (str ? start + str + end : "");
    const indent = (str) => (str ? "  " + str.replace(/\n/g, "\n  ") : str);

    function selKept(n) {
      if (hasClient(n)) return false;
      if (n.kind === "FragmentSpread" && emptyFrags.has(n.name.value)) return false;
      return true;
    }
    // Apollo Client injiziert vor jedem Request automatisch __typename in
    // jedes Selection-Set (addTypenameToDocument) — ohne das kann der Server
    // Union-/Interface-Felder (z.B. SearchDocument.item) nicht auflösen.
    function block(arr) {
      const kept = (arr || []).filter(selKept);
      if (!kept.length) return "";
      const hasTypename = kept.some(n => n.kind === "Field" && n.name.value === "__typename");
      const body = hasTypename ? kept.map(print) : ["__typename", ...kept.map(print)];
      return "{\n" + indent(join(body, "\n")) + "\n}";
    }
    const printDirectives = (ds) => wrap(" ", join((ds || []).filter(d => d.name.value !== "client").map(print), " "));
    function printType(t) {
      if (t.kind === "NonNullType") return printType(t.type) + "!";
      if (t.kind === "ListType") return "[" + printType(t.type) + "]";
      return t.name.value;
    }
    function printValue(v) {
      switch (v.kind) {
        case "Variable": return "$" + v.name.value;
        case "IntValue": case "FloatValue": return v.value;
        case "StringValue": return JSON.stringify(v.value);
        case "BooleanValue": return String(v.value);
        case "NullValue": return "null";
        case "EnumValue": return v.value;
        case "ListValue": return "[" + join(v.values.map(printValue), ", ") + "]";
        case "ObjectValue": return "{" + join(v.fields.map(f => f.name.value + ": " + printValue(f.value)), ", ") + "}";
        default: return "";
      }
    }
    function print(n) {
      switch (n.kind) {
        case "Document": {
          const defs = n.definitions.filter(d => !(d.kind === "FragmentDefinition" && emptyFrags.has(d.name.value)));
          return join(defs.map(print), "\n\n") + "\n";
        }
        case "OperationDefinition": {
          const varDefs = wrap("(", join(n.variableDefinitions.map(print), ", "), ")");
          const prefix = join([n.operation, join([n.name && n.name.value, varDefs])], " ") + printDirectives(n.directives);
          return prefix + " " + print(n.selectionSet);
        }
        case "VariableDefinition":
          return "$" + n.variable.name.value + ": " + printType(n.type) + (n.defaultValue ? " = " + printValue(n.defaultValue) : "");
        case "SelectionSet": return block(n.selections);
        case "Field": {
          const args = wrap("(", join((n.arguments || []).map(print), ", "), ")");
          const alias = n.alias ? n.alias.value + ": " : "";
          return alias + n.name.value + args + printDirectives(n.directives) + wrap(" ", n.selectionSet && print(n.selectionSet));
        }
        case "Argument": return n.name.value + ": " + printValue(n.value);
        case "FragmentSpread": return "..." + n.name.value + printDirectives(n.directives);
        case "InlineFragment": {
          const cond = n.typeCondition ? " on " + n.typeCondition.name.value : "";
          return "..." + cond + printDirectives(n.directives) + " " + print(n.selectionSet);
        }
        case "FragmentDefinition":
          return "fragment " + n.name.value + " on " + n.typeCondition.name.value + printDirectives(n.directives) + " " + print(n.selectionSet);
        case "Directive": return "@" + n.name.value + wrap("(", join((n.arguments || []).map(print), ", "), ")");
        default: return "";
      }
    }
    // Fixpunkt: Fragmente, die (rekursiv) nur @client-Felder oder nur leere
    // Fragmente enthalten, komplett rausnehmen statt leer zu drucken.
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const name in fragmentsByName) {
        if (emptyFrags.has(name)) continue;
        if (fragmentsByName[name].selectionSet.selections.filter(selKept).length === 0) { emptyFrags.add(name); changed = true; }
      }
      if (!changed) break;
    }
    return print(ast);
  }

  // ZDFs Bundle serialisiert die AST als JS-Objektliteral mit unquoted Keys
  // (kind:"Document", nicht "kind":"Document") — kein gültiges JSON. new
  // Function()/eval ist per MV3-Extension-CSP blockiert, daher Keys außerhalb
  // von String-Literalen selbst quoten (Strings vorher maskieren, damit
  // Doppelpunkte/Klammern in echten Textwerten nicht mit-ersetzt werden).
  function jsObjectLiteralToJson(src) {
    const strings = [];
    const masked = src.replace(/"(?:[^"\\]|\\.)*"/g, (m) => { strings.push(m); return ` ${strings.length - 1} `; });
    const withQuotedKeys = masked.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
    return withQuotedKeys.replace(/ (\d+) /g, (_, i) => strings[Number(i)]);
  }

  function findDocFor(bundleText, opName) {
    const nameIdx = bundleText.indexOf(`name:{kind:"Name",value:"${opName}"}`);
    if (nameIdx === -1) return null;
    const docStart = bundleText.lastIndexOf('{kind:"Document"', nameIdx);
    if (docStart === -1) return null;
    const src = extractBalanced(bundleText, docStart);
    if (!src) return null;
    try { return JSON.parse(jsObjectLiteralToJson(src)); } catch { return null; }
  }

  function getToken() {
    const scripts = [...document.querySelectorAll("script")];
    const tokenScript = scripts.find(s => s.textContent && s.textContent.includes("apiAuthToken"));
    if (!tokenScript) return null;
    const text = tokenScript.textContent;
    const match = text.match(/apiAuthToken\\\":\\\"([^\\"]+)/) || text.match(/apiAuthToken":"([^"]+)"/);
    return match ? match[1] : null;
  }

  return (async () => {
    const token = getToken();
    if (!token) return { error: "Kein API-Token auf der Seite gefunden." };

    const srcs = [...document.querySelectorAll("script[src]")].map(s => s.src).filter(u => u.includes("/_next/"));
    const found = {};
    for (const url of srcs) {
      if (Object.keys(found).length === Object.keys(OPERATIONS).length) break;
      let text;
      try { text = await (await fetch(url)).text(); } catch { continue; }
      for (const opName of Object.keys(OPERATIONS)) {
        if (found[opName]) continue;
        if (!text.includes(`"${opName}"`)) continue;
        const ast = findDocFor(text, opName);
        if (ast) found[opName] = printDocument(ast);
      }
    }

    const result = {};
    for (const [opName, variables] of Object.entries(OPERATIONS)) {
      const queryText = found[opName];
      if (!queryText) { result[opName] = { ok: false, error: "Nicht im Bundle gefunden." }; continue; }
      try {
        const res = await fetch("https://api.zdf.de/graphql", {
          method: "POST",
          headers: { "api-auth": `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ query: queryText, variables })
        });
        const json = await res.json().catch(() => null);
        if (res.ok && json && !json.errors) result[opName] = { ok: true, query: queryText };
        else result[opName] = { ok: false, error: json?.errors?.[0]?.message || `HTTP ${res.status}` };
      } catch (e) {
        result[opName] = { ok: false, error: e.message };
      }
    }
    return result;
  })();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "findQuickSearchQueries") return;
  (async () => {
    // Next.js lädt den Such-Bundle-Chunk nur auf Seiten, die die Suche tatsächlich
    // mounten (z.B. /suche) — auf der Startseite ist er evtl. gar nicht geladen.
    // Erst /suche-Tabs probieren, sonst der Reihe nach alle offenen zdf.de-Tabs.
    const tabs = await chrome.tabs.query({ url: "*://www.zdf.de/*" });
    tabs.sort((a, b) => (b.url?.includes("/suche") ? 1 : 0) - (a.url?.includes("/suche") ? 1 : 0));
    if (tabs.length === 0) { sendResponse({ error: "Kein offener zdf.de-Tab gefunden — erst zdf.de öffnen." }); return; }

    const merged = {};
    for (const tab of tabs) {
      const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: findSearchQueriesInPage })
        .catch(e => [{ result: { error: e.message } }]);
      const res = injected?.result;
      if (res?.error) continue; // z.B. kein Token auf dieser Seite -> nächster Tab
      for (const [name, r] of Object.entries(res || {})) {
        if (r.ok && !merged[name]?.ok) merged[name] = r;
        else if (!merged[name]) merged[name] = r;
      }
      if (Object.values(merged).every(r => r.ok)) break;
    }
    sendResponse(Object.keys(merged).length ? merged : { error: "Auf keinem offenen zdf.de-Tab gefunden — /suche einmal öffnen und erneut versuchen." });
  })();
  return true;
});
