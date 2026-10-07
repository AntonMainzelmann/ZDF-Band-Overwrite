// ZDF Toolkit — Lane Override (läuft im MAIN world der Seite)
// Tauscht die Items eines Reco-Bandes direkt in ZDFs Apollo-Client statt Kacheln im DOM
// zu klonen. React rendert dann echte Kacheln — mit Hover-Zoom, Tracking, Fortschritt,
// korrekten Links. Die Bänder kommen per GetClusterList (fetchPolicy "no-cache"), die
// Daten liegen also nicht im Apollo-Cache, sondern nur in der ObservableQuery selbst;
// ObservableQuery.setResult schiebt neue Daten an React durch.
// MAIN world, weil nur hier die React-Fiber (__reactFiber$…) am DOM sichtbar sind.
// Brücke zu main.js (isolated world, macht SageMaker) per postMessage.
(() => {
  "use strict";

  const log = (...args) => console.log("[lane-override]", ...args);

  // Item-Selektion der GetClusterList-Query enthält Fragmente für alle Teaser-Typen
  // (SmartCollections, MetaCollection, LiveTv, …). videosByIds liefert nur Video, jedes
  // andere Typ-Fragment wäre ein GRAPHQL_VALIDATION_FAILED. Per Probe gegen die API
  // ermittelt: Video implementiert TeaserDocument, sonst passt nichts.
  // ponytail: feste Liste — kommt ein neues Interface für Video dazu, fehlen dessen
  // Felder still (kein Fehler). Dann hier ergänzen.
  const VIDEO_TYPES = new Set(["Video", "TeaserDocument"]);

  const originals = new Map(); // label -> { oq, result }
  const docCache = new WeakMap(); // GetClusterList-Doc -> videosByIds-Doc

  // ApolloProvider hängt irgendwo über jeder Kachel im Fiber-Baum, sein client-Prop
  // ist der Client. Kein window-Global in Produktion.
  function findApolloClient(el) {
    const key = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    for (let f = key && el[key]; f; f = f.return) {
      const client = f.memoizedProps?.client;
      if (client?.cache && client.getObservableQueries) return client;
    }
    return null;
  }

  function findClusterQuery(client, label) {
    for (const oq of client.getObservableQueries("all").values()) {
      if (oq.queryName !== "GetClusterList") continue;
      const clusters = oq.getCurrentResult().data?.clusterlist?.clusters;
      if (clusters?.some(c => c.clusterLabel === label)) return oq;
    }
    return null;
  }

  // Baut aus ZDFs GetClusterList-Dokument "query($ids){ videosByIds(ids){ <Item-Selektion> } }".
  // Fragment-Spreads auf Item-Ebene werden inline aufgelöst, damit Nicht-Video-Fragmente
  // rausfallen können; verschachtelte Spreads (in Feldern) bleiben und bringen ihre
  // FragmentDefinitions mit.
  function buildVideosDoc(doc) {
    if (docCache.has(doc)) return docCache.get(doc);
    const N = value => ({ kind: "Name", value });
    const fragDef = name => doc.definitions.find(d => d.kind === "FragmentDefinition" && d.name.value === name);
    const field = (ss, name) => ss.selections.find(s => s.kind === "Field" && s.name.value === name);

    const op = doc.definitions.find(d => d.kind === "OperationDefinition");
    const items = field(field(field(op.selectionSet, "clusterlist").selectionSet, "clusters").selectionSet, "items");

    const prune = ss => ({
      kind: "SelectionSet",
      selections: ss.selections.flatMap(s => {
        if (s.kind === "FragmentSpread") {
          const d = fragDef(s.name.value);
          if (!VIDEO_TYPES.has(d.typeCondition.name.value)) return [];
          return [{ kind: "InlineFragment", typeCondition: d.typeCondition, directives: [], selectionSet: prune(d.selectionSet) }];
        }
        if (s.kind === "InlineFragment") {
          if (s.typeCondition && !VIDEO_TYPES.has(s.typeCondition.name.value)) return [];
          return [{ ...s, selectionSet: prune(s.selectionSet) }];
        }
        return [s];
      })
    });
    const selectionSet = prune(items.selectionSet);

    const used = new Set();
    const collect = ss => ss?.selections.forEach(s => {
      if (s.kind !== "FragmentSpread") return collect(s.selectionSet);
      if (used.has(s.name.value)) return;
      used.add(s.name.value);
      collect(fragDef(s.name.value).selectionSet);
    });
    collect(selectionSet);

    const idsType = { kind: "NonNullType", type: { kind: "ListType", type: { kind: "NonNullType", type: { kind: "NamedType", name: N("String") } } } };
    const videosDoc = {
      kind: "Document",
      definitions: [
        {
          kind: "OperationDefinition", operation: "query", name: N("ToolkitRecoItems"), directives: [],
          variableDefinitions: [{ kind: "VariableDefinition", variable: { kind: "Variable", name: N("ids") }, type: idsType }],
          selectionSet: { kind: "SelectionSet", selections: [{
            kind: "Field", name: N("videosByIds"), directives: [],
            arguments: [{ kind: "Argument", name: N("ids"), value: { kind: "Variable", name: N("ids") } }],
            selectionSet
          }] }
        },
        ...doc.definitions.filter(d => d.kind === "FragmentDefinition" && used.has(d.name.value))
      ]
    };
    docCache.set(doc, videosDoc);
    return videosDoc;
  }

  function setItems(oq, baseResult, label, items) {
    const data = baseResult.data;
    oq.setResult({
      ...baseResult,
      data: {
        ...data,
        clusterlist: {
          ...data.clusterlist,
          clusters: data.clusterlist.clusters.map(c => c.clusterLabel === label ? { ...c, items } : c)
        }
      }
    });
  }

  async function override(label, ids) {
    const tile = document.querySelector(`[aria-label="${CSS.escape(label)}"] [data-testid="teaser-tile"]`);
    const client = tile && findApolloClient(tile);
    const oq = client && findClusterQuery(client, label);
    if (!oq) { log(`kein GetClusterList für "${label}"`); return false; }

    const res = await client.query({ query: buildVideosDoc(oq.query), variables: { ids }, fetchPolicy: "no-cache" });
    const byId = new Map((res.data?.videosByIds || []).filter(Boolean).map(v => [v.id, v]));
    const items = ids.map(id => byId.get(id)).filter(Boolean); // Reco-Reihenfolge halten
    if (!items.length) { log(`keine Videos für "${label}"`); return false; }

    if (!originals.has(label)) originals.set(label, { oq, result: oq.getCurrentResult() });
    setItems(oq, originals.get(label).result, label, items);
    log(`"${label}" ersetzt durch`, items.length, "Videos");
    return true;
  }

  function restore(label) {
    const orig = originals.get(label);
    if (!orig) return false;
    orig.oq.setResult(orig.result);
    originals.delete(label);
    return true;
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "zdf-lane-bridge") return;
    let ok = false;
    try {
      ok = msg.type === "override" ? await override(msg.label, msg.ids) : restore(msg.label);
    } catch (e) {
      log(`Fehler bei "${msg.label}":`, e);
    }
    window.postMessage({ source: "zdf-lane-override", id: msg.id, ok }, "*");
  });
})();
