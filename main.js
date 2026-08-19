// ZDF Band Overwrite — Debug Extension
// Ersetzt die Kacheln eines bestimmten Bands mit hart-codierten Fake-Items.

(() => {
  "use strict";

  // ============================================================
  // KONFIGURATION — hier anpassen
  // ============================================================

  // Welches Band soll ersetzt werden? Matcht gegen aria-label der lane.
  const TARGET_LABEL = "Das könnte Dich interessieren";

  // Set auf true um mehr Konsolen-Output zu sehen
  const DEBUG = true;

  // ============================================================
  // IMPLEMENTIERUNG & ZUSTAND
  // ============================================================

  const log = (...args) => DEBUG && console.log("[overwrite]", ...args);

  let isOverwritten = false;
  let cachedTemplate = null;
  let userDeactivated = false; // Verhindert Auto-Overwrite nach manuellem Deaktivieren

  // Findet die Ziel-Lane anhand des aria-label.
  function findTargetLane() {
    return document.querySelector(`[aria-label="${CSS.escape(TARGET_LABEL)}"]`);
  }

  // Findet den Container in dem die einzelnen Kachel-Wrapper leben.
  function findTileContainer(lane) {
    const anyTile = lane.querySelector('[data-testid="teaser-tile"]');
    if (!anyTile) return null;
    let wrapper = anyTile;
    while (wrapper && !wrapper.classList.contains("sq9dowx")) {
      wrapper = wrapper.parentElement;
    }
    return wrapper?.parentElement || null;
  }

  // Alle Kachel-Wrapper (Elemente mit Klasse sq9dowx die eine teaser-tile enthalten).
  function findAllTileWrappers(container) {
    return [...container.children].filter(el =>
      el.classList?.contains("sq9dowx") &&
      el.querySelector('[data-testid="teaser-tile"]')
    );
  }

  // Klont einen Kachel-Wrapper und patcht die Inhalte für ein Fake-Item.
  function buildTileFromTemplate(template, item) {
    const clone = template.cloneNode(true);

    // Anchor: href + aria-controls
    const a = clone.querySelector("a[href]");
    if (a) {
      a.href = item.href;
      a.setAttribute("aria-controls", item.id);
      a.setAttribute("aria-expanded", "false");
    }

    // Hero-Bild: alle <picture>-sources und img mit der Teaser-URL überschreiben.
    const pictures = clone.querySelectorAll("picture");
    if (pictures[0]) patchPicture(pictures[0], item.image);
    if (pictures[1] && item.logo) patchPicture(pictures[1], item.logo);

    // Titel
    const h3 = clone.querySelector("h3");
    if (h3) h3.textContent = item.title;

    // Sender-Label ("ZDF" / "ZDFtivi" etc.)
    const channel = clone.querySelector(".c1xd5kkr");
    if (channel && item.channel) channel.textContent = item.channel;

    // Badges (UT, DGS, FSK)
    const badgeContainer = clone.querySelector(".cm4kr6w");
    if (badgeContainer) {
      badgeContainer.innerHTML = "";
      const titleMap = { UT: "Untertitel", DGS: "Deutsche Gebärdensprache",
                         AD: "Audiodeskription", "0": "Ohne Einschränkung",
                         "6": "Ab 6", "12": "Ab 12", "18": "Ab 18" };
      for (const b of item.badges || []) {
        const abbr = document.createElement("abbr");
        abbr.className = "t1midc0q s97ep7d";
        abbr.title = titleMap[b] || b;
        abbr.textContent = b;
        badgeContainer.appendChild(abbr);
      }
    }

    // Subtitle-Zeile
    const subtitle = clone.querySelector(".b1lunumd");
    if (subtitle) subtitle.textContent = item.subtitle || "";

    // "Neues Video"-Label ggf. entfernen
    const newLabel = clone.querySelector('[data-testid="new-content"]');
    if (newLabel) newLabel.remove();

    // Markieren dass wir die Kachel manipuliert haben
    clone.dataset.overwritten = "1";

    return clone;
  }

  // Setzt in einem <picture> alle srcset und das <img>-src auf dieselbe URL.
  function patchPicture(picture, url) {
    picture.querySelectorAll("source").forEach(s => {
      const parts = (s.getAttribute("srcset") || "").split(",").map(p => {
        const [_, desc] = p.trim().split(/\s+/);
        return desc ? `${url} ${desc}` : url;
      });
      s.setAttribute("srcset", parts.join(", "));
    });
    const img = picture.querySelector("img");
    if (img) img.src = url;
  }

  // Ruft die angerechteten Items aus dem ausgelagerten zdfApi-Modul ab.
  async function fetchDebugItems() {
    if (window.zdfApi && typeof window.zdfApi.fetchDebugItems === "function") {
      return await window.zdfApi.fetchDebugItems();
    }
    log("Fehler: zdfApi-Modul wurde nicht geladen.");
    return [];
  }

  // Der Hauptreplace.
  async function overwriteLane(lane) {
    if (isOverwritten) return;
    log("overwriting lane:", lane);

    const container = findTileContainer(lane);
    if (!container) { log("no container found"); return; }

    const wrappers = findAllTileWrappers(container);
    if (wrappers.length === 0) { log("no tiles to use as template"); return; }

    // Template klonen BEVOR wir den Container ausblenden.
    if (!cachedTemplate) {
      cachedTemplate = wrappers[0].cloneNode(true);
    }
    log("template captured, tiles present:", wrappers.length);

    let items;
    try {
      items = await fetchDebugItems();
    } catch (e) {
      console.error("[overwrite] fetch failed:", e);
      return;
    }

    // Original-Kacheln ausblenden und markieren, anstatt sie zu löschen
    wrappers.forEach(w => {
      w.style.display = "none";
      w.setAttribute("data-original-tile", "1");
    });

    // Neue überschriebene Kacheln einfügen
    for (const item of items) {
      container.appendChild(buildTileFromTemplate(cachedTemplate, item));
    }

    isOverwritten = true;
    lane.dataset.overwritten = "1";
    log("replaced with", items.length, "fake items");
  }

  // Original-Zustand wiederherstellen
  function restoreOriginalLane(lane) {
    if (!isOverwritten) return;
    log("restoring original lane:", lane);

    const container = findTileContainer(lane);
    if (!container) { log("no container found"); return; }

    // Überschriebene Kacheln entfernen
    const overwrittenTiles = container.querySelectorAll('[data-overwritten="1"]');
    overwrittenTiles.forEach(t => t.remove());

    // Original-Kacheln wieder einblenden
    const originalTiles = container.querySelectorAll('[data-original-tile="1"]');
    originalTiles.forEach(t => {
      t.style.display = "";
      t.removeAttribute("data-original-tile");
    });

    isOverwritten = false;
    lane.removeAttribute("data-overwritten");
    log("original lane restored");
  }

  // Warten bis das Band im DOM ist.
  async function start() {
    const { isActive } = await chrome.storage.local.get("isActive");
    userDeactivated = isActive === false;

    const existing = findTargetLane();
    if (existing && existing.querySelector('[data-testid="teaser-tile"]')) {
      if (!userDeactivated) {
        overwriteLane(existing);
      }
      return;
    }

    const observer = new MutationObserver(() => {
      if (userDeactivated) return;
      const lane = findTargetLane();
      if (!lane) return;
      // Warten bis Kacheln drin sind (nicht nur Skeleton)
      if (!lane.querySelector('[data-testid="teaser-tile"]')) return;
      if (lane.dataset.overwritten === "1" || isOverwritten) return;
      overwriteLane(lane);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Nach 30s aufgeben um nicht unendlich Ressourcen zu verbrauchen
    setTimeout(() => observer.disconnect(), 30000);
  }

  // Listener für Nachrichten von background.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "toggleOverwrite") {
      log("Received toggleOverwrite message. ForceState:", message.forceState);
      const lane = findTargetLane();
      if (!lane) {
        log("Target lane not found on this page.");
        return;
      }

      const targetState = message.forceState !== undefined ? message.forceState : !isOverwritten;
      if (!targetState) {
        userDeactivated = true; // Merken, dass der User es deaktiviert hat
        restoreOriginalLane(lane);
      } else {
        userDeactivated = false; // User aktiviert es wieder
        overwriteLane(lane);
      }
    }
  });

  start();
})();
