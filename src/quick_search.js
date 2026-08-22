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
  // Kategorien-Einträge haben kein Bild -> reine Farbfläche mit Titel. Größe kommt komplett
  // von außen (renderResults berechnet sie), hier nur volle Breite/Höhe der Grid-Zelle.
  function buildCard(item, i) {
    const card = document.createElement("a");
    card.href = item.href;
    card.dataset.index = String(i);
    card.style.cssText = `position:relative;display:block;width:100%;height:100%;border-radius:9px;
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

  const GRID_GAP = 14;   // entspricht CSS .9rem, hier als px für die Layoutrechnung
  const MIN_CARD_W = 200; // darunter werden keine Karten mehr angezeigt statt weiter zu schrumpfen
                          // (200 -> beim vollen 1400px-Panel genau 6 Spalten, also 12 Teaser in 2 Zeilen)
  const MAX_CARD_W = 340; // darüber wirkt eine einzelne Karte wie ein Hero-Banner statt Teaser

  // Feste Panelhöhe (siehe openOverlay), also passt sich hier die Kartengröße dem Platz an,
  // nicht das Panel der Ergebniszahl. Karten skalieren zwischen MIN_CARD_W und MAX_CARD_W,
  // um Breite UND Höhe zu füllen; passen bei MIN_CARD_W nicht alle Items rein, werden die
  // überzähligen weggelassen (kein Scrollen, kein Schrumpfen darunter). Reines CSS (auto-fit/
  // minmax) kann das nicht: das kennt nur die Breite, nicht wie viele Zeilen bei fixer Höhe reinpassen.
  function renderResults() {
    resultsEl.innerHTML = "";
    const visible = sections.filter(s => s.items.length);
    if (!visible.length) return;

    // Pass 1: nur Überschriften + leere Grids einhängen, um deren tatsächlich belegte
    // Höhe direkt vom Browser messen zu lassen statt zu schätzen.
    const headingEls = [];
    const grids = visible.map((section, sIdx) => {
      if (section.label) {
        const heading = document.createElement("div");
        heading.textContent = section.label;
        heading.style.cssText = `font:600 13px/1.3 -apple-system,sans-serif;
          color:#9a9a9a;text-transform:uppercase;letter-spacing:.04em;margin:${sIdx === 0 ? "0" : ".9rem"} 0 .1rem;`;
        resultsEl.appendChild(heading);
        headingEls.push(heading);
      }
      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;gap:" + GRID_GAP + "px;";
      resultsEl.appendChild(grid);
      return grid;
    });

    const cs = getComputedStyle(resultsEl);
    const availW = resultsEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    // Überschriftenhöhe pro Element aufsummieren (offsetHeight + Margins). NICHT über
    // resultsEl.scrollHeight messen: scrollHeight ist nie kleiner als clientHeight, die
    // Messung lieferte also die volle Panelhöhe und availH wurde negativ -> es blieb
    // genau eine Zeile für genau eine Sektion übrig, alle weiteren Sektionen verschwanden.
    const headingsHeight = headingEls.reduce((sum, el) => {
      const m = getComputedStyle(el);
      return sum + el.offsetHeight + parseFloat(m.marginTop) + parseFloat(m.marginBottom);
    }, 0);
    const availH = resultsEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - headingsHeight;
    const counts = visible.map(s => s.items.length);

    // Umgekehrte Logik zu vorher: nicht die Kartengröße an "alle Items müssen rein" anpassen,
    // sondern die Karten frei zwischen MIN und MAX skalieren und überzählige Items schlicht
    // weglassen. Pro Spaltenzahl c: Kartenbreite = Panelbreite exakt auf c Spalten verteilt
    // (gekappt bei MAX), daraus folgt, wie viele Zeilen in die feste Höhe passen und damit,
    // wie viele Items sichtbar wären. Gewählt wird das c, das die meisten Items zeigt —
    // bei Gleichstand (z.B. nur 2 Treffer, passen immer) das mit der größeren Karte.
    function planFor(c) {
      const w = Math.min((availW - (c - 1) * GRID_GAP) / c, MAX_CARD_W);
      if (w < MIN_CARD_W) return null;
      const h = w * 9 / 16;
      const totalRows = Math.max(1, Math.floor((availH + GRID_GAP) / (h + GRID_GAP)));
      // Zeilen auf die Sektionen verteilen: reihum je eine, bis der Bedarf gedeckt ist
      // oder keine Zeilen mehr übrig sind (Reihenfolge = Sektionsreihenfolge, d.h.
      // Top-Ergebnisse bekommen ihre erste Zeile vor "Alle Ergebnisse" die zweite).
      const need = counts.map(n => Math.ceil(n / c));
      const rows = counts.map(() => 0);
      let remaining = totalRows, gave = true;
      while (remaining > 0 && gave) {
        gave = false;
        for (let s = 0; s < rows.length && remaining > 0; s++) {
          if (rows[s] < need[s]) { rows[s]++; remaining--; gave = true; }
        }
      }
      const shownCounts = counts.map((n, s) => Math.min(n, rows[s] * c));
      return { c, w, h, shownCounts, shown: shownCounts.reduce((a, b) => a + b, 0) };
    }

    let best = null;
    const maxColumns = Math.max(1, Math.floor((availW + GRID_GAP) / (MIN_CARD_W + GRID_GAP)));
    for (let c = 1; c <= maxColumns; c++) {
      const plan = planFor(c);
      if (!plan) break;
      if (!best || plan.shown > best.shown || (plan.shown === best.shown && plan.w > best.w)) best = plan;
    }
    if (!best) best = { c: 1, w: Math.max(availW, 50), h: Math.max(availW, 50) * 9 / 16, shownCounts: counts.map((n, s) => (s === 0 ? Math.min(n, 1) : 0)), shown: 1 };

    // Pass 2: nur die sichtbaren Items in die vorbereiteten Grids füllen; items-Liste für
    // die Tastaturnavigation auf genau diese beschränken, damit Enter nie ein unsichtbares
    // Ergebnis öffnet. Sektionen, für die keine Zeile mehr übrig war, verlieren ihr Heading.
    items = [];
    let i = 0;
    grids.forEach((grid, sIdx) => {
      const shown = best.shownCounts[sIdx];
      if (!shown) {
        if (visible[sIdx].label) grid.previousElementSibling?.remove(); // Heading der leer ausgegangenen Sektion
        grid.remove();
        return;
      }
      grid.style.gridTemplateColumns = `repeat(${best.c}, ${best.w}px)`;
      grid.style.gridAutoRows = `${best.h}px`;
      for (const item of visible[sIdx].items.slice(0, shown)) {
        items.push(item);
        grid.appendChild(buildCard(item, i));
        i++;
      }
    });
    if (activeIndex >= items.length) activeIndex = items.length ? 0 : -1;
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
      <div id="zdf-qs-panel" style="width:min(92vw,1400px);height:85vh;background:rgba(28,28,28,.2);
        backdrop-filter:blur(12px);border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.5);
        display:flex;flex-direction:column;overflow:hidden;">
        <input id="zdf-qs-input" type="text" placeholder="ZDF durchsuchen…" autocomplete="off"
          style="border:none;outline:none;background:transparent;color:#fff;font-size:24px;flex:none;
          padding:1.1rem 1.4rem;border-bottom:1px solid rgba(255,255,255,.1);" />
        <div id="zdf-qs-results" style="flex:1;min-height:0;overflow-y:auto;padding:1rem 1.2rem 1.2rem;"></div>
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
