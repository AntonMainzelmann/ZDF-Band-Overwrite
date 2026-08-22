// ZDF Toolkit — Popup
// Ersetzt den alten Klick-auf-Icon-toggelt-direkt-Mechanismus und das
// unstylebare native Kontextmenü: echtes HTML-Popup mit Toggles + Template-Liste.

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const NEXT_VIDEO_KEY = "__nextVideo__"; // muss zu main.js passen

const tabPromise = chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab);

// ---------- Bänder (+ Next-Video): je ein Toggle statt eines globalen Schalters ----------

function toggleRowHtml(id, label, active) {
  return `<button type="button" class="toggleRow${active ? " on" : ""}" data-id="${esc(id)}">
    <span class="dot2"></span>
    <span class="label">${esc(label)}</span>
    <span class="state">${active ? "AN" : "AUS"}</span>
  </button>`;
}

async function renderBandToggles() {
  const list = document.getElementById("bandToggleList");
  const { bandConfigs = [], bandActive = {}, nextVideoConfig } =
    await chrome.storage.local.get(["bandConfigs", "bandActive", "nextVideoConfig"]);

  const entries = bandConfigs.map(c => ({ id: c.label, label: c.label }));
  if (nextVideoConfig?.endpoint) entries.push({ id: NEXT_VIDEO_KEY, label: "Next-Video" });

  if (entries.length === 0) {
    list.innerHTML = `<p class="hint">Keine Bänder konfiguriert. <a id="openOptionsInline1">Einstellungen öffnen</a>.</p>`;
    list.querySelector("#openOptionsInline1").addEventListener("click", () => chrome.runtime.openOptionsPage());
    return;
  }

  list.innerHTML = entries.map(e => toggleRowHtml(e.id, e.label, bandActive[e.id] !== false)).join("");

  list.querySelectorAll(".toggleRow").forEach(row => {
    row.addEventListener("click", async () => {
      const id = row.dataset.id;
      const { bandActive: current = {} } = await chrome.storage.local.get("bandActive");
      const active = !(current[id] !== false);
      await chrome.storage.local.set({ bandActive: { ...current, [id]: active } });

      const tab = await tabPromise;
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { action: "toggleOverwrite", label: id, forceState: active }).catch(() => {
          // Tritt auf, wenn die aktive Seite kein zdf.de-Content-Script hat.
        });
      }
      renderBandToggles();
    });
  });
}

// ---------- Quick Search: eigener Storage-Key, quick_search.js reagiert live per storage.onChanged ----------

async function renderQuickSearchToggle() {
  const list = document.getElementById("quickSearchToggleList");
  const { quickSearch = {} } = await chrome.storage.local.get("quickSearch");
  const enabled = quickSearch.enabled !== false;

  list.innerHTML = toggleRowHtml("quickSearch", "Quick Search", enabled);

  list.querySelector(".toggleRow").addEventListener("click", async () => {
    const { quickSearch: current = {} } = await chrome.storage.local.get("quickSearch");
    await chrome.storage.local.set({ quickSearch: { ...current, enabled: !(current.enabled !== false) } });
    renderQuickSearchToggle();
  });
}

// ---------- A/B-Gruppe: direktes Setzen im localStorage der Zielseite (kein
// An/Aus-Override — Auswahl schreibt sofort und lädt die Seite neu) ----------

async function renderAbGroup() {
  const box = document.getElementById("abGroupBox");
  const { abGroups = [] } = await chrome.storage.local.get("abGroups");

  if (abGroups.length === 0) {
    box.innerHTML = `<p class="hint">Keine Gruppen geladen. <a id="openOptionsInline2">Einstellungen öffnen</a>.</p>`;
    box.querySelector("#openOptionsInline2").addEventListener("click", () => chrome.runtime.openOptionsPage());
    return;
  }

  const tab = await tabPromise;
  const current = tab?.id
    ? (await chrome.runtime.sendMessage({ action: "getAbGroup", tabId: tab.id }).catch(() => ({}))).group
    : null;

  box.innerHTML = `
    <select id="abGroupSelect">
      <option value="">– wählen –</option>
      ${abGroups.map(g => `<option value="${esc(g.name)}" ${g.name === current ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
    </select>
    <p class="abGroupCurrent">Aktuell gesetzt: ${current ? esc(current) : "unbekannt"}</p>
  `;

  box.querySelector("#abGroupSelect").addEventListener("change", async (e) => {
    const group = e.target.value;
    if (!group || !tab?.id) return;
    await chrome.runtime.sendMessage({ action: "setAbGroup", tabId: tab.id, group });
    await chrome.tabs.reload(tab.id);
    window.close();
  });
}

async function renderTemplates() {
  const { jsonTemplates = [] } = await chrome.storage.local.get("jsonTemplates");
  const list = document.getElementById("templateList");
  const pageTypeLabel = document.getElementById("pageTypeLabel");

  const tab = await tabPromise;
  const { pageTypeId, pageTypeName } = tab?.id
    ? await chrome.runtime.sendMessage({ action: "detectPageType", tabId: tab.id })
    : { pageTypeId: null, pageTypeName: null };
  pageTypeLabel.textContent = pageTypeName ? `Seitentyp: ${pageTypeName}` : "Seitentyp: unbekannt";

  // Templates ohne Seitentyp gelten für alle Seiten, Templates mit Seitentyp
  // nur wenn er zum erkannten Typ der aktuellen Seite passt.
  const matching = jsonTemplates.filter(t => !t.pageTypeId || t.pageTypeId === pageTypeId);

  if (jsonTemplates.length === 0) {
    list.innerHTML = `<p class="hint">Keine Templates konfiguriert. <a id="openOptionsInline">Einstellungen öffnen</a>.</p>`;
    list.querySelector("#openOptionsInline").addEventListener("click", () => chrome.runtime.openOptionsPage());
    return;
  }
  if (matching.length === 0) {
    list.innerHTML = `<p class="hint">Keine Templates für diesen Seitentyp. <a id="openOptionsInline">Einstellungen öffnen</a>.</p>`;
    list.querySelector("#openOptionsInline").addEventListener("click", () => chrome.runtime.openOptionsPage());
    return;
  }

  list.innerHTML = matching.map(t => `<button type="button" class="tplBtn" data-id="${t.id}">${esc(t.name) || "(ohne Namen)"}</button>`).join("");

  list.querySelectorAll(".tplBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const tab = await tabPromise;
      if (!tab?.id) return;
      btn.disabled = true;
      btn.textContent = "Lädt …";
      await chrome.runtime.sendMessage({ action: "runJsonTemplate", templateId: btn.dataset.id, tabId: tab.id });
      window.close();
    });
  });
}

document.getElementById("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

renderBandToggles();
renderQuickSearchToggle();
renderAbGroup();
renderTemplates();
