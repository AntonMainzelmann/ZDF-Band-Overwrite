// ZDF Band Overwrite — Next-Video Interceptor (läuft im MAIN world der Seite)
// Muss im Page-Context laufen, weil der NextVideo-Request vom ZDF-Player
// selbst kommt (window.fetch der Seite), nicht vom Content-Script. MAIN-world
// Skripte haben aber keinen chrome.*-Zugriff, daher Brücke per postMessage zu
// main.js (isolated world), das die eigentliche SageMaker/GraphQL-Arbeit macht.
(() => {
  "use strict";

  const GRAPHQL_URL = "https://api.zdf.de/graphql";
  const originalFetch = window.fetch.bind(window);
  const pending = new Map();
  let reqCounter = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "zdf-nv-bridge" || msg.type !== "response") return;
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    resolve(msg.result);
  });

  function askBridge(request) {
    const id = ++reqCounter;
    return new Promise(resolve => {
      pending.set(id, resolve);
      window.postMessage({ source: "zdf-nv-interceptor", type: "request", id, ...request }, "*");
      // ponytail: fixer Timeout statt Retry/Queue — Bridge antwortet praktisch
      // sofort, das hier fängt nur den Fall "main.js noch nicht geladen" ab.
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 5000);
    });
  }

  // Klammer-zählendes Skip: liefert den Index direkt nach einem balancierten
  // (...) oder {...}-Block ab Startindex `i` (Zeichen an `i` muss die
  // öffnende Klammer sein).
  function skipBalanced(text, i, open, close) {
    let depth = 1; i++;
    while (depth > 0 && i < text.length) {
      if (text[i] === open) depth++;
      else if (text[i] === close) depth--;
      i++;
    }
    return i;
  }

  // Holt Alias + Feld-Selektion von z.B. "nextVideo(videoId: $videoId, ...) { a b c }"
  // per Klammer-Zählung statt Regex über den ganzen Block — Query-Text hat
  // beliebig verschachtelte { } in der Selection, ein Regex-Match würde da abreißen.
  function extractSelection(query, fieldName) {
    const aliasMatch = query.match(new RegExp(`(\\w+)\\s*:\\s*${fieldName}\\s*\\(`));
    const key = aliasMatch ? aliasMatch[1] : fieldName;
    const callIdx = query.search(new RegExp(`\\b${fieldName}\\s*\\(`));
    if (callIdx < 0) return null;
    const afterArgs = skipBalanced(query, query.indexOf("(", callIdx), "(", ")");
    const braceStart = query.indexOf("{", afterArgs);
    if (braceStart < 0) return null;
    const braceEnd = skipBalanced(query, braceStart, "{", "}");
    return { key, selection: query.slice(braceStart + 1, braceEnd - 1) };
  }

  // Zerlegt eine Feld-Selektion in ihre direkten (nicht verschachtelten)
  // Felder — z.B. "recoId\nclusterId\nitems { ... on Video { id title } }"
  // -> [{name:"recoId"}, {name:"clusterId"}, {name:"items", block:"... on Video { id title }"}].
  // Wird gebraucht, weil nextVideo() kein Video direkt liefert, sondern einen
  // Wrapper { recoId, clusterId, configuration, items: [Video] } — die
  // Antwort muss diese Form nachbilden, nicht nur das Video selbst.
  function parseTopLevelFields(selection) {
    const fields = [];
    let i = 0;
    while (i < selection.length) {
      while (i < selection.length && /\s/.test(selection[i])) i++;
      if (i >= selection.length) break;
      const m = selection.slice(i).match(/^(\.\.\.\s*on\s+\w+|\w+)/);
      if (!m) { i++; continue; }
      const name = m[0];
      i += m[0].length;
      while (i < selection.length && /\s/.test(selection[i])) i++;
      if (selection[i] === "(") i = skipBalanced(selection, i, "(", ")");
      while (i < selection.length && /\s/.test(selection[i])) i++;
      let block = null;
      if (selection[i] === "{") {
        const end = skipBalanced(selection, i, "{", "}");
        block = selection.slice(i + 1, end - 1);
        i = end;
      }
      fields.push({ name, block });
    }
    return fields;
  }

  // Variablendefinitionen der Operation, z.B. "($videoId: String!, $first: Int, ...)".
  function extractVarDefs(query) {
    const qIdx = query.indexOf("query");
    if (qIdx < 0) return "";
    let i = qIdx;
    while (i < query.length && query[i] !== "(" && query[i] !== "{") i++;
    if (query[i] !== "(") return "";
    const end = skipBalanced(query, i, "(", ")");
    return query.slice(i, end);
  }

  // Zerlegt "($a: Int, $b: [String!]!, ...)" in einzelne "$name: Type"-Einträge
  // (Klammerzählung nur für [ ], da Typen keine ( ) enthalten).
  function splitVarDefs(varDefsText) {
    if (!varDefsText) return [];
    const inner = varDefsText.slice(1, -1);
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === "," && depth === 0) { parts.push(inner.slice(start, i).trim()); start = i + 1; }
    }
    const last = inner.slice(start).trim();
    if (last) parts.push(last);
    return parts;
  }

  // GraphQL verlangt, dass jede deklarierte Variable auch benutzt wird
  // ("NoUnusedVariables") — deshalb nur die Var-Defs übernehmen, die
  // tatsächlich in der jeweiligen Selection vorkommen (z.B. $first in
  // moods(first: $first)), nicht den kompletten Satz der Original-Query.
  function usedVarDefs(varDefsText, selection) {
    return splitVarDefs(varDefsText).filter(def => {
      const m = def.match(/^\$(\w+)/);
      return m && new RegExp(`\\$${m[1]}\\b`).test(selection);
    });
  }

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    if (url !== GRAPHQL_URL || !init?.body) return originalFetch(input, init);

    let payload;
    try { payload = JSON.parse(init.body); } catch { return originalFetch(input, init); }
    if (payload.operationName !== "NextVideo") return originalFetch(input, init);

    const videoId = payload.variables?.videoId;
    const outer = videoId ? extractSelection(payload.query || "", "nextVideo") : null;
    if (!outer) return originalFetch(input, init);

    const topFields = parseTopLevelFields(outer.selection);
    const itemsField = topFields.find(f => f.name === "items" && f.block != null);
    // Zwei Formen, je nachdem was nextVideo() laut Query zurückgibt: Wrapper
    // mit items[] (aktuelle API-Form), oder direkt ein Video (falls ZDF das
    // mal ändert) -> scalarFields bleibt dann leer.
    const perVideoSelection = itemsField ? itemsField.block : outer.selection;
    const request = {
      videoId,
      key: outer.key,
      varDefs: usedVarDefs(extractVarDefs(payload.query || ""), perVideoSelection),
      variables: payload.variables || {},
      itemsSelection: itemsField ? itemsField.block : null,
      scalarFields: itemsField ? topFields.filter(f => f !== itemsField && f.block == null).map(f => f.name) : [],
      singleSelection: itemsField ? null : outer.selection
    };

    const result = await askBridge(request);
    if (!result) return originalFetch(input, init); // kein Override konfiguriert/fehlgeschlagen -> Original-Request

    return new Response(JSON.stringify({ data: { [outer.key]: result } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
})();
