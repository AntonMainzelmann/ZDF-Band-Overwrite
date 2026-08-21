// ZDF Band Overwrite — Popup
// Ersetzt den alten Klick-auf-Icon-toggelt-direkt-Mechanismus und das
// unstylebare native Kontextmenü: echtes HTML-Popup mit Toggle + Template-Liste.

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const tabPromise = chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab);

async function getIsActive() {
  const { isActive } = await chrome.storage.local.get("isActive");
  return isActive !== false; // Default: aktiv
}

async function renderToggle() {
  const active = await getIsActive();
  const row = document.getElementById("toggleActive");
  row.classList.toggle("on", active);
  document.getElementById("toggleLabel").textContent = `Band Overwrite: ${active ? "AN" : "AUS"}`;
}

document.getElementById("toggleActive").addEventListener("click", async () => {
  const isActive = !(await getIsActive());
  await chrome.storage.local.set({ isActive });

  const tab = await tabPromise;
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: "toggleOverwrite", forceState: isActive }).catch(() => {
      // Tritt auf, wenn die aktive Seite kein zdf.de-Content-Script hat.
    });
  }
  renderToggle();
});

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

renderToggle();
renderTemplates();
