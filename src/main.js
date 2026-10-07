// ZDF Toolkit — Debug Extension
// Ersetzt die Kacheln konfigurierter Bänder mit Items aus konfigurierten Endpunkten.

(() => {
  "use strict";

  const DEBUG = true;
  const log = (...args) => DEBUG && console.log("[overwrite]", ...args);

  // zdf.de/<uuid> (404) -> Canonical-URL des Videos, damit man eine ID direkt
  // in die Adressleiste kippen kann.
  const idMatch = location.pathname.match(/^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
  if (idMatch) {
    chrome.storage.local.get("idResolver")
      .then(({ idResolver }) => idResolver?.enabled === false ? null : window.zdfApi?.resolveIdToUrl(idMatch[1]))
      .then(url => url ? location.replace(url) : log("keine Canonical für ID (oder deaktiviert)", idMatch[1]))
      .catch(e => log("ID-Auflösung fehlgeschlagen:", e));
  }

  // Meldet jede SPA-Navigation ans Background-Script (siehe dortiger
  // "pageNavigated"-Handler), damit die Seitentyp-Erkennung laufend neue
  // Seitentypen lernen kann, ohne dass dafür das Popup geöffnet werden muss.
  // zdf.de ist eine Next.js-SPA — normale URL-/load-Events reichen nicht,
  // client-seitige Navigation läuft über history.pushState/replaceState.
  let lastNavUrl = location.href;
  function notifyNavigation() {
    if (location.href === lastNavUrl) return;
    lastNavUrl = location.href;
    chrome.runtime.sendMessage({ action: "pageNavigated" }).catch(() => {});
  }
  for (const fn of ["pushState", "replaceState"]) {
    const original = history[fn];
    history[fn] = function (...args) {
      const result = original.apply(this, args);
      notifyNavigation();
      return result;
    };
  }
  window.addEventListener("popstate", notifyNavigation);
  chrome.runtime.sendMessage({ action: "pageNavigated" }).catch(() => {}); // initialer Seitenaufruf

  // Zustand pro Band (Map: label -> { isOverwritten, cachedTemplate, config, active }).
  const bandState = new Map();
  const NEXT_VIDEO_KEY = "__nextVideo__"; // Toggle-Key für den Next-Video-Eintrag im Popup
  let nextVideoActive = true;

  // Findet die Ziel-Lane anhand des aria-label.
  function findLaneByLabel(label) {
    return document.querySelector(`[aria-label="${CSS.escape(label)}"]`);
  }

  // Findet den Container in dem die einzelnen Kachel-Wrapper leben.
  function findTileContainer(lane) {
    // ponytail: Struktur container > wrapper > a[teaser-tile]; ZDF-CSS-Klassen sind
    // Build-Hashes und ändern sich bei jedem Deploy, daher nicht darauf matchen.
    const anyTile = lane.querySelector('[data-testid="teaser-tile"]');
    return anyTile?.parentElement?.parentElement || null;
  }

  // Alle Kachel-Wrapper (direkte Kinder des Containers mit einer teaser-tile).
  function findAllTileWrappers(container) {
    return [...container.children].filter(el =>
      el.querySelector(':scope > [data-testid="teaser-tile"]')
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
    // pictures[1] = Sendungslogo der Template-Kachel. Ohne eigenes Logo (z.B. ARD-Inhalte)
    // entfernen, sonst klebt das Logo der Template-Sendung (z.B. "Hacks") auf fremden Videos.
    if (pictures[1]) item.logo ? patchPicture(pictures[1], item.logo) : pictures[1].remove();

    // ZDF blendet Bilder per `img:not(.img-shown) { opacity: 0 }` aus und setzt
    // "img-shown" erst per React-onLoad. Unser Clone läuft nie durch React, daher
    // selbst setzen, sonst bleibt das Bild in lazy Lanes (z.B. "Weiterschauen") unsichtbar.
    pictures.forEach(pic => pic.querySelector("img")?.classList.add("img-shown"));

    // SageMaker-Score als Badge unten rechts aufs Bild — dunkles Pill mit weißer
    // Schrift, damit es auf hellen wie dunklen Teaser-Bildern lesbar bleibt.
    // ponytail: hart aus; bei Bedarf als Schalter in die Optionen ziehen.
    const SHOW_SCORE = false;
    const imageWrap = pictures[0]?.parentElement;
    if (SHOW_SCORE && imageWrap && typeof item.score === "number") {
      imageWrap.style.position = "relative";
      const badge = document.createElement("div");
      badge.textContent = item.score.toFixed(2);
      badge.style.cssText = "position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,0.7);"
        + "color:#fff;font:600 11px/1.4 -apple-system,sans-serif;padding:1px 6px;border-radius:4px;"
        + "pointer-events:none;z-index:2;";
      imageWrap.appendChild(badge);
    }

    // Titel
    const h3 = clone.querySelector("h3");
    if (h3) h3.textContent = item.title;

    // Badges (UT, DGS, FSK) — einziges stabiles Attribut; Sender davor, Subtitle danach.
    const badgeContainer = clone.querySelector('[origin="teasertile"]');

    // Sender-Label ("ZDF" / "ZDFtivi" etc.)
    const channel = badgeContainer?.previousElementSibling;
    if (channel && item.channel) channel.textContent = item.channel;

    if (badgeContainer) {
      const abbrClass = badgeContainer.querySelector("abbr")?.className || "";
      badgeContainer.innerHTML = "";
      const titleMap = { UT: "Untertitel", DGS: "Deutsche Gebärdensprache",
                         AD: "Audiodeskription", "0": "Ohne Einschränkung",
                         "6": "Ab 6", "12": "Ab 12", "18": "Ab 18" };
      for (const b of item.badges || []) {
        const abbr = document.createElement("abbr");
        abbr.className = abbrClass;
        abbr.title = titleMap[b] || b;
        abbr.textContent = b;
        badgeContainer.appendChild(abbr);
      }
    }

    // Subtitle-Zeile
    const subtitle = badgeContainer?.nextElementSibling;
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
    // ZDF setzt srcset inzwischen auch direkt am <img> — das schlägt src, sonst bliebe
    // das Template-Bild in jeder Kachel stehen.
    const img = picture.querySelector("img");
    if (img) { img.removeAttribute("srcset"); img.src = url; }
  }

  // Ruft die angerechteten Items aus dem ausgelagerten zdfApi-Modul ab.
  async function fetchDebugItems(config) {
    if (window.zdfApi && typeof window.zdfApi.fetchDebugItems === "function") {
      return await window.zdfApi.fetchDebugItems(config);
    }
    log("Fehler: zdfApi-Modul wurde nicht geladen.");
    return [];
  }

  // Unsere Kacheln stecken in Reacts Original-Wrappern, die Hover-Handler fürs Original
  // tragen — sonst klappt die Detail-Ansicht des versteckten Originals (z.B. "Hacks") auf.
  // React leitet Enter/Leave aus mouseover/mouseout am Root ab und nimmt dabei auch
  // relatedTarget: kommt die Maus aus einer Lücke zwischen den Kacheln, ist unsere Kachel
  // nur relatedTarget. Daher global in der Capture-Phase blocken, sobald target ODER
  // relatedTarget unsere Kachel ist — sonst geht die Ansicht auf und nie mehr zu.
  const isOurTile = n => !!n?.closest?.('[data-overwritten="1"]');
  for (const type of ["mouseover", "mouseout", "pointerover", "pointerout", "focusin", "focusout", "click"]) {
    window.addEventListener(type, e => {
      if (isOurTile(e.target) || isOurTile(e.relatedTarget)) e.stopPropagation();
    }, true);
  }

  // Brücke zu lane_override.js (MAIN world): tauscht die Band-Items in ZDFs Apollo-Client,
  // React rendert dann echte Kacheln. Antwort false = Band kommt nicht per GetClusterList
  // (oder Fehler) -> DOM-Klon-Fallback unten.
  let laneReqId = 0;
  function askLaneOverride(request) {
    const id = ++laneReqId;
    return new Promise(resolve => {
      const onMsg = (event) => {
        const msg = event.data;
        if (event.source !== window || msg?.source !== "zdf-lane-override" || msg.id !== id) return;
        window.removeEventListener("message", onMsg);
        resolve(msg.ok);
      };
      window.addEventListener("message", onMsg);
      window.postMessage({ source: "zdf-lane-bridge", id, ...request }, "*");
      // ponytail: fixer Timeout — fängt nur "lane_override.js nicht geladen" ab.
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve(false); }, 10000);
    });
  }

  // Der Hauptreplace für ein Band.
  async function overwriteLane(label, lane) {
    const state = bandState.get(label);
    // Synchron vor jedem await sperren: der MutationObserver ruft tryOverwrite
    // beliebig oft während des laufenden Fetches auf, sonst rutschen mehrere
    // parallele Aufrufe durch und hängen doppelte Kachel-Batches an.
    if (state.isOverwritten || state.isOverwriting) return;
    state.isOverwriting = true;
    log(`overwriting lane "${label}":`, lane);

    const container = findTileContainer(lane);
    if (!container) { log("no container found"); state.isOverwriting = false; return; }

    const wrappers = findAllTileWrappers(container);
    if (wrappers.length === 0) { log("no tiles to use as template"); state.isOverwriting = false; return; }

    // Template klonen BEVOR wir den Container ausblenden.
    if (!state.cachedTemplate) {
      state.cachedTemplate = wrappers[0].cloneNode(true);
    }
    log("template captured, tiles present:", wrappers.length);

    let items;
    try {
      items = await fetchDebugItems(state.config);
    } catch (e) {
      console.error("[overwrite] fetch failed:", e);
      state.isOverwriting = false;
      return;
    }

    if (items.length && await askLaneOverride({ type: "override", label, ids: items.map(i => i.id) })) {
      state.mode = "apollo";
      state.isOverwritten = true;
      lane.dataset.toolkitLane = "1";
      log(`replaced "${label}" via Apollo with`, items.length, "items");
      return;
    }
    state.mode = "dom";

    // Fallback (Band nicht per GetClusterList): DOM-Klone.
    // Die React-Wrapper bleiben sichtbar, nur ihr <a> wird getauscht: ZDFs Weiter/Zurück-
    // Buttons blättern über React-Refs auf genau diese Wrapper — mit display:none hätten
    // sie kein Layout und das Band bliebe auf Position 1–4 stehen.
    wrappers.forEach((w, i) => {
      const orig = w.querySelector(':scope > [data-testid="teaser-tile"]');
      orig.style.display = "none";
      orig.setAttribute("data-original-tile", "1");
      if (i < items.length) {
        const a = buildTileFromTemplate(state.cachedTemplate, items[i]).querySelector("a");
        a.dataset.overwritten = "1";
        w.appendChild(a);
      } else {
        w.style.display = "none"; // überzählige Originale
        w.setAttribute("data-original-tile", "1");
      }
    });
    // Mehr Items als Original-Kacheln: Rest als lose Klone anhängen (ohne Blätter-Ref).
    for (const item of items.slice(wrappers.length)) {
      container.appendChild(buildTileFromTemplate(state.cachedTemplate, item));
    }


    state.isOverwritten = true;
    lane.dataset.toolkitLane = "1";
    log(`replaced "${label}" with`, items.length, "fake items");
  }

  // Original-Zustand wiederherstellen
  function restoreOriginalLane(label, lane) {
    const state = bandState.get(label);
    if (!state.isOverwritten) return;
    log(`restoring original lane "${label}":`, lane);

    if (state.mode === "apollo") {
      askLaneOverride({ type: "restore", label });
      state.isOverwritten = false;
      state.isOverwriting = false;
      lane.removeAttribute("data-toolkit-lane");
      return;
    }

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

    state.isOverwritten = false;
    state.isOverwriting = false;
    lane.removeAttribute("data-toolkit-lane");
    log(`original lane "${label}" restored`);
  }

  function tryOverwrite(label) {
    const state = bandState.get(label);
    if (!state?.active) return;
    const lane = findLaneByLabel(label);
    if (!lane) return;
    // Warten bis Kacheln drin sind (nicht nur Skeleton)
    if (!lane.querySelector('[data-testid="teaser-tile"]')) return;
    if (lane.dataset.toolkitLane === "1" || state.isOverwritten) return;
    overwriteLane(label, lane);
  }

  // Next-Video: Brücke für nextvideo_interceptor.js (MAIN world, kein
  // chrome.*-Zugriff dort). Hält die aktuelle Config, damit der Listener sie
  // nicht bei jedem Request neu aus dem Storage lesen muss.
  let nextVideoConfig = null;
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "zdf-nv-interceptor" || msg.type !== "request") return;

    let result = null;
    if (nextVideoActive && nextVideoConfig?.endpoint) {
      result = await window.zdfApi.fetchNextVideoOverride(msg, nextVideoConfig).catch(() => null);
    }
    window.postMessage({ source: "zdf-nv-bridge", type: "response", id: msg.id, result }, "*");
  });

  // Tracking Enhancer: läuft im MAIN world (tracking_enhancer.js) und kommt dort
  // nicht an chrome.storage — Zustand also von hier aus reinreichen.
  function pushTrackingEnhancer(enabled) {
    window.postMessage({ source: "zdf-te-bridge", enabled }, "*");
  }
  chrome.storage.local.get("trackingEnhancer").then(({ trackingEnhancer }) => {
    pushTrackingEnhancer(trackingEnhancer?.enabled === true);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.trackingEnhancer) {
      pushTrackingEnhancer(changes.trackingEnhancer.newValue?.enabled === true);
    }
  });

  // Warten bis die konfigurierten Bänder im DOM sind.
  async function start() {
    const { bandActive = {}, bandConfigs = [], nextVideoConfig: nvConfig } =
      await chrome.storage.local.get(["bandActive", "bandConfigs", "nextVideoConfig"]);
    nextVideoConfig = nvConfig?.endpoint ? nvConfig : null;
    nextVideoActive = bandActive[NEXT_VIDEO_KEY] !== false;

    if (bandConfigs.length === 0) {
      log("Keine Bänder konfiguriert (siehe Erweiterungs-Optionen).");
      return;
    }

    for (const config of bandConfigs) {
      bandState.set(config.label, {
        isOverwritten: false, cachedTemplate: null, config,
        active: bandActive[config.label] !== false
      });
    }

    for (const config of bandConfigs) {
      tryOverwrite(config.label);
    }

    const observer = new MutationObserver(() => {
      for (const config of bandConfigs) {
        tryOverwrite(config.label);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Nach 30s aufgeben um nicht unendlich Ressourcen zu verbrauchen
    setTimeout(() => observer.disconnect(), 30000);
  }

  // Zeigt das Ergebnis eines JSON-Templates (siehe background.js) als Overlay an.
  function showJsonOverlay({ title, data, error, pageType }) {
    document.getElementById("zdf-json-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "zdf-json-overlay";
    overlay.style.cssText = `
      position: fixed; top: 1rem; right: 1rem; bottom: 1rem; width: min(60vw, 760px);
      background: rgba(30,30,30,.88); backdrop-filter: blur(6px); color: #d4d4d4;
      z-index: 2147483647; border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,.4);
      display: flex; flex-direction: column; font-family: ui-monospace, monospace; font-size: 12px;
    `;
    overlay.innerHTML = `
      <div style="padding:.6rem .8rem;border-bottom:1px solid #333;">
        <div style="display:flex;align-items:center;gap:.5rem;">
          <strong id="zdf-json-overlay-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;"></strong>
          <button id="zdf-json-overlay-close" style="background:none;border:none;color:#aaa;font-size:16px;cursor:pointer;">✕</button>
        </div>
        <div id="zdf-json-overlay-pagetype" style="margin-top:.2rem;color:#8ab;display:none;"></div>
      </div>
      <pre id="zdf-json-overlay-body" style="margin:0;padding:.8rem;overflow:auto;flex:1;white-space:pre-wrap;word-break:break-word;${error ? "color:#f66;" : ""}"></pre>
    `;
    // textContent statt innerHTML für die dynamischen Werte: data kommt aus der
    // API-Response (Video-Metadaten) und darf nicht als HTML interpretiert werden.
    overlay.querySelector("#zdf-json-overlay-title").textContent = title;
    overlay.querySelector("#zdf-json-overlay-body").textContent = error ? `Fehler: ${error}` : JSON.stringify(data, null, 2);
    if (pageType) {
      const pageTypeEl = overlay.querySelector("#zdf-json-overlay-pagetype");
      pageTypeEl.textContent = `Seitentyp: ${pageType}`;
      pageTypeEl.style.display = "";
    }
    document.body.appendChild(overlay);

    const close = () => {
      overlay.remove();
      document.removeEventListener("click", onOutsideClick, true);
    };
    function onOutsideClick(e) {
      if (!overlay.contains(e.target)) close();
    }
    // capture-phase + minimale Verzögerung: verhindert, dass der Klick, der
    // das Overlay überhaupt erst öffnet (Popup-Button), es sofort wieder schließt.
    setTimeout(() => document.addEventListener("click", onOutsideClick, true), 0);

    overlay.querySelector("#zdf-json-overlay-close").addEventListener("click", close);
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
    });
  }

  // Listener für Nachrichten von background.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "showJsonOverlay") {
      showJsonOverlay(message);
      return;
    }
    if (message.action === "toggleOverwrite") {
      log("Received toggleOverwrite message.", message.label, message.forceState);

      if (message.label === NEXT_VIDEO_KEY) {
        nextVideoActive = message.forceState;
        return;
      }

      const state = bandState.get(message.label);
      if (!state) return;
      state.active = message.forceState;

      const lane = findLaneByLabel(message.label);
      if (!lane) return;
      if (state.active) {
        overwriteLane(message.label, lane);
      } else {
        restoreOriginalLane(message.label, lane);
      }
    }
  });

  start();
})();
