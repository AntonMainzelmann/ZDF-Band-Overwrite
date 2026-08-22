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

  const seen = new Map();      // lane-Element -> Map(assetId -> Position im Band)
  const clickedLanes = new Set();
  const observed = new WeakSet();
  const dwellTimers = new WeakMap();

  // ---------- Sichtbarkeit ----------

  const laneOf = (anchor) => anchor.closest('[role="region"][aria-label]');

  function markSeen(anchor) {
    const lane = laneOf(anchor);
    const assetId = anchor.getAttribute("aria-controls");
    if (!lane || !assetId) return;
    const anchors = [...lane.querySelectorAll("a[aria-controls]")];
    if (!seen.has(lane)) seen.set(lane, new Map());
    const laneSeen = seen.get(lane);
    if (laneSeen.has(assetId)) return;
    laneSeen.set(assetId, anchors.indexOf(anchor));
    log("sichtbar:", lane.getAttribute("aria-label"), assetId, `(${laneSeen.size} von ${anchors.length})`);
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
    clickedLanes.clear();
  }

  // ---------- Events senden ----------

  function send(url) {
    url.searchParams.set("trackingEnhancer", MARKER);
    navigator.sendBeacon(url);
    log("beacon:", url.href);
  }

  function attachTeasers(url, lane, laneSeen, excludeAssetId) {
    const total = lane.querySelectorAll("a[aria-controls]").length;
    const defeated = [...laneSeen].filter(([id]) => id !== excludeAssetId);
    url.searchParams.set("clusterLabel", lane.getAttribute("aria-label") || "");
    url.searchParams.set("deliveredTeaserCount", String(total));
    url.searchParams.set("seenTeaserCount", String(laneSeen.size));
    url.searchParams.set("defeatedAssetIds", defeated.map(([id]) => id).join(","));
    url.searchParams.set("defeatedPositions", defeated.map(([, pos]) => pos).join(","));
  }

  // Klick im Band: Original-URL hat schon clusterId, recoId, recoModel,
  // configuration und die Positionen — wir hängen nur die Verlierer an.
  function onClickEvent(originalUrl) {
    const targetAssetId = originalUrl.searchParams.get("targetAssetId");
    if (!targetAssetId) return;

    const lane = [...seen.keys()].find(l => seen.get(l).has(targetAssetId))
      || laneOf(document.querySelector(`a[aria-controls="${CSS.escape(targetAssetId)}"]`) || document.body);
    if (!lane) return;

    clickedLanes.add(lane);
    const laneSeen = seen.get(lane) || new Map();
    const url = new URL(originalUrl.href);
    attachTeasers(url, lane, laneSeen, targetAssetId);
    send(url);
  }

  // Kein Klick: eigenes Event beim Verlassen. Ohne Click-URL fehlen clusterId
  // und recoId — die stehen weder im DOM noch im RSC-Payload, nur in der
  // GetClusterList-Antwort. clusterLabel ist der Ersatz-Schlüssel.
  function flushImpressions() {
    if (!enabled || !baseUrl) return;
    for (const [lane, laneSeen] of seen) {
      if (clickedLanes.has(lane) || laneSeen.size === 0) continue;
      const url = new URL(baseUrl.href);
      url.searchParams.set("eventType", "impression");
      attachTeasers(url, lane, laneSeen, null);
      send(url);
    }
    clickedLanes.clear();
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

  window.__zdfTrackingEnhancer = { get enabled() { return enabled; }, seen, get baseUrl() { return baseUrl; } };
})();
