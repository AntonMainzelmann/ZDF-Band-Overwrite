// ZDF Toolkit — Tracking Enhancer (läuft im MAIN world der Seite)
//
// Problem: ZDFs eigenes Tracking kennt nur zwei Ereignisse — einen "view" pro
// Seitenaufruf und einen "click" pro Teaser-Klick (Modul 2sga8qf6j909k.js,
// class ZdfTag). Ein Band liefert bis zu 26 Teaser aus, sichtbar sind davon
// aber nur ~4-6. Für den Recommender sieht damit jeder ausgelieferte Teaser
// wie eine Impression aus, echte Negatives lassen sich nicht bilden.
//
// Dieses Skript misst per IntersectionObserver, welche Teaser wirklich sichtbar
// waren, und schickt ein zusätzliches Event an denselben Endpunkt — als
// sendBeacon (POST, tracksrv antwortet darauf mit 204), damit es einen
// Seitenwechsel überlebt. Zwei Fälle:
//
//   1. Klick im Band  -> Kopie der Original-Click-URL + defeatedAssetIds
//                        (sichtbar, aber nicht geklickt).
//   2. Kein Klick     -> eigenes eventType=impression beim Verlassen der Seite,
//                        alle sichtbaren Teaser sind dann "defeated".
//
// Jedes Event trägt trackingEnhancer=zdf-toolkit, damit es serverseitig sauber
// von echtem Traffic getrennt werden kann. MAIN world ist Pflicht: der
// Original-Request kommt aus window.fetch der Seite, nicht vom Content-Script.
(() => {
  "use strict";

  const TRACKSRV = "https://tracksrv.zdf.de/event";
  const MARKER = "zdf-toolkit";
  const VISIBLE_RATIO = 0.5;   // halbe Kachel im Viewport zählt als sichtbar
  const DWELL_MS = 1000;       // ... und das mindestens so lange (Durchwischen zählt nicht)
  const SCAN_MS = 1500;

  const DEBUG = true;
  const log = (...a) => DEBUG && console.log("[tracking-enhancer]", ...a);

  let enabled = false;
  // Erstes view-Event der Seite: trägt trackingId, appId, abGroup, loggedIn,
  // userAge/-Gender/-SegmentId, assetId, pagePath. Basis für unsere eigenen
  // Events, die sonst keinen dieser Kontextwerte kennen würden.
  let baseUrl = null;
  let lastUrl = location.href;

  const seen = new Map();      // Cluster-Element -> Map(assetId -> { pos, title })
  const clickedClusters = new Set();
  const observed = new WeakSet();
  const dwellTimers = new WeakMap();

  // ---------- Sichtbarkeit ----------

  // Zwei Bauformen: Bänder (Startseite, Kollektionen) sind ein horizontales
  // Karussell mit role="region" + aria-label. Der Empfehlungs-Block auf
  // Video-Seiten ist dagegen eine schlichte <ol> im Tab-Panel, ganz ohne
  // Landmark — ohne den zweiten Zweig fiel der komplett durchs Raster.
  const clusterOf = (anchor) =>
    anchor.closest('[role="region"][aria-label]') || anchor.closest("ol, ul");

  // Name des Clusters: aria-label beim Band, sonst die Beschriftung des
  // Tab-Panels ("Empfehlungen") und als letzte Instanz die nächste Überschrift
  // oberhalb der Liste.
  function clusterName(container) {
    const aria = container.getAttribute("aria-label");
    if (aria) return aria;
    const panel = container.closest("[role=tabpanel][aria-labelledby]");
    const tab = panel && document.getElementById(panel.getAttribute("aria-labelledby"));
    if (tab?.textContent.trim()) return tab.textContent.trim();
    for (let el = container.parentElement; el; el = el.parentElement) {
      const heading = [...el.children].find(c => /^H[1-3]$/.test(c.tagName));
      if (heading) return heading.textContent.trim();
    }
    return "";
  }

  // Das h3 einer Kachel enthält zwei divs (Sendungsreihe + Episodentitel) ohne
  // Trennzeichen dazwischen — textContent würde sie zusammenkleben.
  function teaserTitle(anchor) {
    const h3 = anchor.querySelector("h3");
    if (!h3) return "";
    return [...h3.childNodes].map(n => n.textContent.trim()).filter(Boolean).join(" · ");
  }

  // Titel wird hier mitgenommen, nicht später nachgeschlagen: die Kachel steht
  // in diesem Moment im DOM, eine ID-Auflösung per GraphQL spart man sich damit
  // komplett (die IDs im Beacon bleiben trotzdem die einzige Nutzlast).
  function markSeen(anchor) {
    const cluster = clusterOf(anchor);
    const assetId = anchor.getAttribute("aria-controls");
    if (!cluster || !assetId) return;
    const anchors = [...cluster.querySelectorAll("a[aria-controls]")];
    // Einzelne verlinkte Listen (Fußzeile, Randnotizen) sind kein Empfehlungs-
    // Cluster — sonst gingen dafür sinnlose impression-Events raus.
    if (anchors.length < 2) return;
    if (!seen.has(cluster)) seen.set(cluster, new Map());
    const clusterSeen = seen.get(cluster);
    if (clusterSeen.has(assetId)) return;
    clusterSeen.set(assetId, {
      pos: anchors.indexOf(anchor),
      title: teaserTitle(anchor) || anchor.getAttribute("href") || assetId
    });
    log("sichtbar:", clusterName(cluster), assetId, `(${clusterSeen.size} von ${anchors.length})`);
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target;
      if (entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO) {
        if (!dwellTimers.has(el)) dwellTimers.set(el, setTimeout(() => markSeen(el), DWELL_MS));
      } else {
        clearTimeout(dwellTimers.get(el));
        dwellTimers.delete(el);
      }
    }
  }, { threshold: [VISIBLE_RATIO] });

  // ponytail: Intervall-Scan statt MutationObserver — Bänder werden lazy
  // nachgeladen, aber ein Sweep pro 1,5 s reicht dafür und kostet nichts.
  function scan() {
    if (!enabled) return;
    if (location.href !== lastUrl) {           // SPA-Navigation: erst flushen, dann zurücksetzen
      flushImpressions();
      reset();
      return;
    }
    for (const a of document.querySelectorAll("a[aria-controls]")) {
      if (observed.has(a)) continue;
      observed.add(a);
      observer.observe(a);
    }
  }

  function reset() {
    lastUrl = location.href;
    baseUrl = null;
    seen.clear();
    clickedClusters.clear();
  }

  // ---------- Events senden ----------

  function send(url) {
    url.searchParams.set("trackingEnhancer", MARKER);
    navigator.sendBeacon(url);
    log("beacon:", url.href);
  }

  function attachTeasers(url, cluster, clusterSeen, excludeAssetId) {
    const total = cluster.querySelectorAll("a[aria-controls]").length;
    const defeated = [...clusterSeen].filter(([id]) => id !== excludeAssetId);
    const label = clusterName(cluster);
    url.searchParams.set("clusterLabel", label);
    url.searchParams.set("deliveredTeaserCount", String(total));
    url.searchParams.set("seenTeaserCount", String(clusterSeen.size));
    url.searchParams.set("defeatedAssetIds", defeated.map(([id]) => id).join(","));
    url.searchParams.set("defeatedPositions", defeated.map(([, e]) => e.pos).join(","));

    if (DEBUG) {
      console.groupCollapsed(`[tracking-enhancer] ${label} — ${clusterSeen.size} von ${total} sichtbar`);
      console.table([...clusterSeen].map(([id, e]) => ({
        pos: e.pos, titel: e.title, assetId: id,
        status: id === excludeAssetId ? "geklickt" : "defeated"
      })));
      console.groupEnd();
    }
  }

  // Klick im Band: Original-URL hat schon clusterId, recoId, recoModel,
  // configuration und die Positionen — wir hängen nur die Verlierer an.
  function onClickEvent(originalUrl) {
    const targetAssetId = originalUrl.searchParams.get("targetAssetId");
    if (!targetAssetId) return;

    const cluster = [...seen.keys()].find(c => seen.get(c).has(targetAssetId))
      || clusterOf(document.querySelector(`a[aria-controls="${CSS.escape(targetAssetId)}"]`) || document.body);
    if (!cluster) return;

    clickedClusters.add(cluster);
    const clusterSeen = seen.get(cluster) || new Map();
    const url = new URL(originalUrl.href);
    attachTeasers(url, cluster, clusterSeen, targetAssetId);
    send(url);
  }

  // Kein Klick: eigenes Event beim Verlassen. Ohne Click-URL fehlen clusterId
  // und recoId — die stehen weder im DOM noch im RSC-Payload, nur in der
  // GetClusterList-Antwort. clusterLabel ist der Ersatz-Schlüssel.
  function flushImpressions() {
    if (!enabled || !baseUrl) return;
    for (const [cluster, clusterSeen] of seen) {
      if (clickedClusters.has(cluster) || clusterSeen.size === 0) continue;
      const url = new URL(baseUrl.href);
      url.searchParams.set("eventType", "impression");
      attachTeasers(url, cluster, clusterSeen, null);
      send(url);
    }
    clickedClusters.clear();
    seen.clear();
  }

  // ---------- fetch-Hook: ZDF ruft fetch mit einem URL-Objekt auf ----------

  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const href = input instanceof URL ? input.href
      : typeof input === "string" ? input
      : input?.url;
    if (enabled && href && href.startsWith(TRACKSRV)) {
      try {
        const url = new URL(href);
        const type = url.searchParams.get("eventType");
        if (type === "view" && !baseUrl) baseUrl = url;
        else if (type === "click") onClickEvent(url);
      } catch { /* kaputte URL -> Original-Request trotzdem durchlassen */ }
    }
    return originalFetch(input, init);
  };

  // ---------- Brücke zu main.js (MAIN world hat kein chrome.*) ----------

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "zdf-te-bridge") return;
    enabled = !!msg.enabled;
    log(enabled ? "aktiv" : "aus");
    if (enabled) scan(); else reset();
  });

  window.addEventListener("pagehide", flushImpressions);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushImpressions();
  });
  setInterval(scan, SCAN_MS);

  // Für IDs, die aus einer Beacon-URL im Network-Tab kopiert wurden: nimmt die
  // komma-separierte Liste (oder gleich die ganze URL) und schlägt die Titel im
  // DOM nach. Konsole: __zdfTrackingEnhancer.resolve("<paste>")
  function resolve(input) {
    const ids = (input.includes("defeatedAssetIds=")
      ? decodeURIComponent(new URL(input, location.href).searchParams.get("defeatedAssetIds") || "")
      : input).split(",").map(s => s.trim()).filter(Boolean);
    const rows = ids.map(id => {
      const a = document.querySelector(`a[aria-controls="${CSS.escape(id)}"]`);
      return { assetId: id, titel: (a && teaserTitle(a)) || "(nicht im DOM)", href: a?.getAttribute("href") || "" };
    });
    console.table(rows);
    return rows;
  }

  window.__zdfTrackingEnhancer = { get enabled() { return enabled; }, seen, get baseUrl() { return baseUrl; }, resolve };
})();
