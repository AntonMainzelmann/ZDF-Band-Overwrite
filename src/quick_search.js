// ZDF Band Overwrite — Quick Search (Spotlight-artiges Overlay)
// Ersetzt die ZDF-eigene Suchseite durch ein Inline-Overlay: Klick auf den
// "Suche"-Link oder Ctrl+Space öffnet es, Ergebnisse kommen live über die
// selbe GraphQL-Suche wie /suche (siehe zdf_api.js searchVideos).
(() => {
  "use strict";

  // Muss zu options/state.js DEFAULT_QUICK_SEARCH passen.
  const DEFAULT_SETTINGS = {
    enabled: true,
    interceptSearchClick: true,
    shortcut: { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: "Space" }
  };
  let settings = { ...DEFAULT_SETTINGS };

  chrome.storage.local.get("quickSearch").then(({ quickSearch }) => {
    if (quickSearch) settings = { ...DEFAULT_SETTINGS, ...quickSearch };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.quickSearch) return;
    settings = { ...DEFAULT_SETTINGS, ...(changes.quickSearch.newValue || {}) };
  });

  function matchesShortcut(e, sc) {
    return e.ctrlKey === !!sc.ctrlKey && e.altKey === !!sc.altKey
      && e.shiftKey === !!sc.shiftKey && e.metaKey === !!sc.metaKey && e.code === sc.code;
  }

  let overlay = null;
  let input = null;
  let resultsEl = null;
  let activeIndex = -1;
  let items = [];
  let debounceTimer = null;
  let requestSeq = 0;

  function closeOverlay() {
    overlay?.remove();
    overlay = null;
    document.removeEventListener("keydown", onKeydownInOverlay, true);
  }

  // Teaser-Karte im Stil der ZDF-Suchseite (Bild + Titel als Overlay unten), nur kleiner.
  function renderResults() {
    resultsEl.innerHTML = "";
    items.forEach((item, i) => {
      const card = document.createElement("a");
      card.href = item.href;
      card.dataset.index = String(i);
      card.style.cssText = `position:relative;display:block;aspect-ratio:16/9;border-radius:8px;
        overflow:hidden;background:#222;text-decoration:none;${i === activeIndex ? "outline:2px solid #fff;" : ""}`;
      if (item.image) {
        const img = document.createElement("img");
        img.src = item.image;
        img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
        card.appendChild(img);
      }
      const gradient = document.createElement("div");
      gradient.style.cssText = "position:absolute;inset:0;background:linear-gradient(transparent 50%,rgba(0,0,0,.85));";
      card.appendChild(gradient);
      const title = document.createElement("span");
      title.textContent = item.title;
      title.style.cssText = `position:absolute;left:0;right:0;bottom:0;padding:.4rem .5rem;color:#fff;
        font:600 12px/1.3 -apple-system,sans-serif;overflow:hidden;text-overflow:ellipsis;
        display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;`;
      card.appendChild(title);
      card.addEventListener("mouseenter", () => setActive(i));
      resultsEl.appendChild(card);
    });
  }

  function setActive(i) {
    activeIndex = i;
    [...resultsEl.children].forEach((card, idx) => {
      card.style.outline = idx === activeIndex ? "2px solid #fff" : "";
    });
  }

  async function runSearch(query) {
    const seq = ++requestSeq;
    const found = query.trim()
      ? await window.zdfApi.searchVideos(query)
      : await window.zdfApi.getDefaultResults(); // "Meistgefunden", wie /suche vor jeder Eingabe
    if (seq !== requestSeq) return; // veraltete Antwort, neuere Eingabe lief bereits
    items = found;
    activeIndex = items.length ? 0 : -1;
    renderResults();
  }

  function onInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(input.value), 250);
  }

  function onKeydownInOverlay(e) {
    if (e.key === "Escape") { e.preventDefault(); closeOverlay(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); if (items.length) setActive((activeIndex + 1) % items.length); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); if (items.length) setActive((activeIndex - 1 + items.length) % items.length); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const target = items[activeIndex];
      if (target) { closeOverlay(); location.href = target.href; }
    }
  }

  function openOverlay() {
    if (overlay) { input.focus(); return; }

    overlay = document.createElement("div");
    overlay.id = "zdf-quick-search";
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;
      display:flex;justify-content:center;padding-top:12vh;font-family:-apple-system,sans-serif;`;
    overlay.innerHTML = `
      <div id="zdf-qs-panel" style="width:min(92vw,900px);max-height:75vh;background:rgba(30,30,30,.95);
        backdrop-filter:blur(12px);border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.5);
        display:flex;flex-direction:column;overflow:hidden;">
        <input id="zdf-qs-input" type="text" placeholder="ZDF durchsuchen…" autocomplete="off"
          style="border:none;outline:none;background:transparent;color:#fff;font-size:20px;
          padding:1rem 1.2rem;border-bottom:1px solid rgba(255,255,255,.1);" />
        <div id="zdf-qs-results" style="overflow-y:auto;padding:.8rem;display:grid;
          grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.6rem;"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    input = overlay.querySelector("#zdf-qs-input");
    resultsEl = overlay.querySelector("#zdf-qs-results");
    items = [];
    activeIndex = -1;

    input.addEventListener("input", onInput);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOverlay(); });
    document.addEventListener("keydown", onKeydownInOverlay, true);

    input.focus();
    runSearch("");
  }

  // ZDF-eigenen Such-Link abfangen statt zur /suche-Seite zu navigieren
  // (per Einstellung getrennt von "enabled" abschaltbar, siehe options/quickSearch).
  document.addEventListener("click", (e) => {
    if (!settings.enabled || !settings.interceptSearchClick) return;
    const link = e.target.closest?.('a[href="/suche"]');
    if (!link) return;
    e.preventDefault();
    openOverlay();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (!settings.enabled || overlay) return;
    if (matchesShortcut(e, settings.shortcut)) {
      e.preventDefault();
      openOverlay();
    }
  });
})();
