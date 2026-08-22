// ZDF Toolkit — Quick Search (Spotlight-artiges Overlay)
// Ersetzt die ZDF-eigene Suchseite durch ein Inline-Overlay: Klick auf den
// "Suche"-Link oder Ctrl+Space öffnet es, Ergebnisse kommen live über die
// selbe GraphQL-Suche wie /suche (siehe zdf_api.js searchVideos). Vor jeder
// Eingabe zeigt es dieselben Bänder wie /suche selbst (Meistgefunden,
// Kategorien, Entdecken) — Kategorien sind bei ZDF eine statische Liste ohne
// eigenen API-Call, daher hier fest hinterlegt (Titel + Ziel-URL geprüft).
(() => {
  "use strict";

  const KATEGORIEN = [
    { title: "A - Z", href: "/sendungen-a-z", image: "https://www.zdf.de/assets/kategorie-a-z-100~276x155" },
    { title: "Barrierefreie Inhalte", href: "/barrierefreiheit-im-zdf", image: "https://www.zdf.de/assets/kategorie-barrierefreiheit-100~276x155" },
    { title: "Satire", href: "/satire", image: "https://www.zdf.de/assets/kategorie-satire-100~276x155" },
    { title: "Sportstudio", href: "/sportstudio-dokus-livestreams-highlights-hintergruende-100", image: "https://www.zdf.de/assets/sportstudio-neutral-buehne-s-teaser-rubrik-100~276x155" },
    { title: "Kultur", href: "/kultur", image: "https://www.zdf.de/assets/kategorie-kultur-100~276x155" },
    { title: "Konzerte", href: "/konzerte", image: "https://www.zdf.de/assets/kategorie-konzerte-100~276x155" },
    { title: "Shows", href: "/shows", image: "https://www.zdf.de/assets/rubriken-shows-100~276x155" },
    { title: "Magazine", href: "/magazine", image: "https://www.zdf.de/assets/kategorie-magazine-100~276x155" },
    { title: "Reportagen", href: "/reportagen", image: "https://www.zdf.de/assets/kategorie-reportagen-100~276x155" },
    { title: "Serien", href: "/serien", image: "https://www.zdf.de/assets/kategorie-serien-100~276x155" },
    { title: "Filme", href: "/filme", image: "https://www.zdf.de/assets/kategorie-filme-100~276x155" },
    { title: "Dokus", href: "/dokus", image: "https://www.zdf.de/assets/kategorie-dokus-100~276x155" }
  ];

  // Muss zu options/state.js DEFAULT_QUICK_SEARCH passen.
  const DEFAULT_SETTINGS = {
    enabled: true,
    interceptSearchClick: true,
    preloadSearch: true,
    shortcut: { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: "Space" }
  };
  let settings = { ...DEFAULT_SETTINGS };

  function applyPrefetchSetting() {
    if (settings.enabled && settings.preloadSearch) startPrefetching(); else stopPrefetching();
  }

  chrome.storage.local.get("quickSearch").then(({ quickSearch }) => {
    if (quickSearch) settings = { ...DEFAULT_SETTINGS, ...quickSearch };
    applyPrefetchSetting();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.quickSearch) return;
    settings = { ...DEFAULT_SETTINGS, ...(changes.quickSearch.newValue || {}) };
    applyPrefetchSetting();
  });

  function matchesShortcut(e, sc) {
    return e.ctrlKey === !!sc.ctrlKey && e.altKey === !!sc.altKey
      && e.shiftKey === !!sc.shiftKey && e.metaKey === !!sc.metaKey && e.code === sc.code;
  }

  let overlay = null;
  let input = null;
  let resultsEl = null;
  let activeIndex = -1;
  let sections = []; // [{ label: string|null, items: {title,href,image}[] }]
  let items = [];    // sections flach, für Tastatur-Navigation/Enter
  let debounceTimer = null;
  let requestSeq = 0;

  // Vorausladen: Standardansicht (Meistgefunden/Kategorien/Entdecken) im Hintergrund
  // bereithalten, damit das Overlay beim Öffnen sofort steht statt erst zu laden.
  // Alle 5 Minuten aufgefrischt, solange Quick Search aktiv ist.
  let cachedDefaultSections = null;
  let prefetchIntervalId = null;
  const PREFETCH_INTERVAL_MS = 5 * 60 * 1000;

  async function buildDefaultSections() {
    const defaultSections = await window.zdfApi.getDefaultSections();
    const byLabel = Object.fromEntries(defaultSections.map(s => [s.label, s.items]));
    return [
      { label: "Meistgefunden", items: byLabel["Meistgefunden"] || [] },
      { label: "Kategorien", items: KATEGORIEN },
      { label: "Entdecken", items: byLabel["Entdecken"] || [] }
    ];
  }

  async function prefetchDefaultSections() {
    try { cachedDefaultSections = await buildDefaultSections(); } catch { /* nächster Tick versucht's erneut */ }
  }

  function startPrefetching() {
    if (prefetchIntervalId) return;
    prefetchDefaultSections();
    prefetchIntervalId = setInterval(prefetchDefaultSections, PREFETCH_INTERVAL_MS);
  }
  function stopPrefetching() {
    clearInterval(prefetchIntervalId);
    prefetchIntervalId = null;
    cachedDefaultSections = null;
  }

  function closeOverlay() {
    overlay?.remove();
    overlay = null;
    document.removeEventListener("keydown", onKeydownInOverlay, true);
  }

  // Teaser-Karte im Stil der ZDF-Suchseite (Bild + Titel als Overlay unten), nur kleiner.
  // Kategorien-Einträge haben kein Bild -> reine Farbfläche mit Titel.
  function buildCard(item, i) {
    const card = document.createElement("a");
    card.href = item.href;
    card.dataset.index = String(i);
    card.style.cssText = `position:relative;display:block;aspect-ratio:16/9;border-radius:9px;
      overflow:hidden;background:#242424;text-decoration:none;${i === activeIndex ? "outline:2px solid #fff;" : ""}`;
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
    title.style.cssText = `position:absolute;left:0;right:0;bottom:0;padding:.5rem .6rem;color:#fff;
      font:600 14px/1.3 -apple-system,sans-serif;overflow:hidden;text-overflow:ellipsis;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;`;
    card.appendChild(title);
    card.addEventListener("mouseenter", () => setActive(i));
    return card;
  }

  function renderResults() {
    resultsEl.innerHTML = "";
    let i = 0;
    sections.forEach((section, sIdx) => {
      if (!section.items.length) return;
      if (section.label) {
        const heading = document.createElement("div");
        heading.textContent = section.label;
        heading.style.cssText = `grid-column:1/-1;font:600 13px/1.3 -apple-system,sans-serif;
          color:#9a9a9a;text-transform:uppercase;letter-spacing:.04em;margin:${sIdx === 0 ? "0" : ".9rem"} 0 .1rem;`;
        resultsEl.appendChild(heading);
      }
      for (const item of section.items) {
        resultsEl.appendChild(buildCard(item, i));
        i++;
      }
    });
  }

  function setActive(i) {
    activeIndex = i;
    [...resultsEl.querySelectorAll("a[data-index]")].forEach(card => {
      card.style.outline = Number(card.dataset.index) === activeIndex ? "2px solid #fff" : "";
    });
  }

  async function runSearch(query) {
    const seq = ++requestSeq;
    let newSections;
    if (query.trim()) {
      newSections = await window.zdfApi.searchVideos(query); // [{label:"Top-Ergebnisse"|"Alle Ergebnisse", items}]
    } else if (settings.preloadSearch && cachedDefaultSections) {
      newSections = cachedDefaultSections;
      prefetchDefaultSections(); // im Hintergrund für den nächsten Open auffrischen
    } else {
      // Preload aus, oder noch kein Prefetch fertig (z.B. direkt nach Seitenload) -> live nachladen.
      newSections = await buildDefaultSections();
      if (settings.preloadSearch) cachedDefaultSections = newSections;
    }
    if (seq !== requestSeq) return; // veraltete Antwort, neuere Eingabe lief bereits
    sections = newSections;
    items = sections.flatMap(s => s.items);
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
      display:flex;justify-content:center;padding-top:10vh;font-family:-apple-system,sans-serif;`;
    overlay.innerHTML = `
      <div id="zdf-qs-panel" style="width:min(92vw,940px);max-height:78vh;background:rgba(28,28,28,.97);
        backdrop-filter:blur(12px);border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.5);
        display:flex;flex-direction:column;overflow:hidden;">
        <input id="zdf-qs-input" type="text" placeholder="ZDF durchsuchen…" autocomplete="off"
          style="border:none;outline:none;background:transparent;color:#fff;font-size:24px;
          padding:1.1rem 1.4rem;border-bottom:1px solid rgba(255,255,255,.1);" />
        <div id="zdf-qs-results" style="overflow-y:auto;padding:1rem 1.2rem 1.2rem;display:grid;
          grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.7rem;"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    input = overlay.querySelector("#zdf-qs-input");
    resultsEl = overlay.querySelector("#zdf-qs-results");
    sections = [];
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
