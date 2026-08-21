import * as state from "./state.js";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function renderAll() {
  renderStart();
  renderEndpoints();
  renderHistory();
  renderPageTypes();
  renderJsonTemplates();
  renderQueryReference();
  renderAbGroup();
}

// ---------- Start: Band-Konfigurationen ----------

function renderStart() {
  const el = document.getElementById("startCards");

  if (state.sagemakerEndpoints.length === 0) {
    el.innerHTML = `<p class="hint">Noch keine Endpunkte konfiguriert. <a data-nav="endpoints">Zu Endpunkte wechseln</a>.</p>`;
    el.querySelector("[data-nav]").addEventListener("click", () => switchView("endpoints"));
    return;
  }

  if (state.configs.length === 0) {
    el.innerHTML = `<p class="hint">Noch keine Konfiguration angelegt.</p>`;
  } else {
    const epOptions = state.sagemakerEndpoints.map(ep => `<option value="${ep.id}">${esc(ep.name) || "(ohne Namen)"}</option>`).join("");
    const presetOptions = `<option value="">(aktuelles Video)</option>` +
      state.historyPresets.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");

    el.innerHTML = state.configs.map(c => {
      const ep = state.sagemakerEndpoints.find(e => e.id === c.sagemakerEndpointId);
      const usable = state.isEndpointUsable(ep);
      return `
      <div class="card" data-config="${c.id}">
        <div class="cardHead">
          <button type="button" class="activeDot ${c.active && usable ? "on" : ""}" ${usable ? "" : "disabled"}
            title="${usable ? "Als aktiv setzen" : "Endpunkt hat keinen API-Key hinterlegt"}"></button>
          <h3 style="flex:1">${esc(c.name) || "(ohne Namen)"}</h3>
          <button type="button" class="btn ghost removeConfig" aria-label="Konfiguration entfernen">✕ Entfernen</button>
        </div>
        ${!usable ? `<p class="hint warn">Kein API-Key am gewählten Endpunkt hinterlegt — diese Konfiguration bleibt inaktiv.</p>` : ""}
        <div class="row">
          <div class="field narrow">
            <label for="type-${c.id}">Typ</label>
            <select id="type-${c.id}" class="f-type">
              <option value="homepage" ${c.type === "homepage" ? "selected" : ""}>Homepage</option>
              <option value="video" ${c.type === "video" ? "selected" : ""}>Video</option>
            </select>
          </div>
          <div class="field labelField" ${c.type === "video" ? 'style="display:none"' : ""}>
            <label for="label-${c.id}">Label (aria-label)</label>
            <select id="label-${c.id}" class="f-label">
              ${state.HOMEPAGE_LABELS.map(l => `<option value="${esc(l)}" ${c.label === l ? "selected" : ""}>${esc(l)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="name-${c.id}">Name</label>
            <input type="text" id="name-${c.id}" class="f-name" required value="${esc(c.name)}" placeholder="z.B. Weiterschauen A/B Test">
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label for="ep-${c.id}">SageMaker-Endpunkt</label>
            <select id="ep-${c.id}" class="f-endpoint" required>
              <option value="">– wählen –</option>
              ${epOptions}
            </select>
          </div>
          <div class="field">
            <label for="history-${c.id}">History</label>
            <select id="history-${c.id}" class="f-history">${presetOptions}</select>
          </div>
          <div class="field narrow">
            <label for="maxItems-${c.id}">Max. Items</label>
            <input type="number" id="maxItems-${c.id}" class="f-maxItems" min="1" value="${c.maxItems || 4}">
          </div>
        </div>
      </div>
    `;
    }).join("");

    // Select-Werte lassen sich nicht zuverlässig per HTML-Attribut auf einen
    // dynamischen Wert setzen (Timing), deshalb hier explizit nachziehen.
    state.configs.forEach(c => {
      document.getElementById(`ep-${c.id}`).value = c.sagemakerEndpointId || "";
      document.getElementById(`history-${c.id}`).value = c.historyPresetId || "";
    });
  }

  el.querySelectorAll(".card").forEach(card => {
    const c = state.configs.find(x => x.id === card.dataset.config);

    card.querySelector(".activeDot").addEventListener("click", () => {
      state.setActiveConfig(c.id);
      renderStart();
    });
    card.querySelector(".removeConfig").addEventListener("click", () => {
      state.removeConfig(c.id);
      renderStart();
    });
    card.querySelector(".f-type").addEventListener("change", e => {
      c.type = e.target.value;
      card.querySelector(".labelField").style.display = c.type === "video" ? "none" : "";
      state.normalizeActiveGroups();
      renderStart();
    });
    const labelSelect = card.querySelector(".f-label");
    if (labelSelect) labelSelect.addEventListener("change", e => {
      c.label = e.target.value;
      state.normalizeActiveGroups();
      renderStart();
    });
    card.querySelector(".f-name").addEventListener("input", e => { c.name = e.target.value; });
    card.querySelector(".f-endpoint").addEventListener("change", e => { c.sagemakerEndpointId = e.target.value || null; });
    card.querySelector(".f-history").addEventListener("change", e => { c.historyPresetId = e.target.value || null; });
    card.querySelector(".f-maxItems").addEventListener("input", e => { c.maxItems = parseInt(e.target.value, 10) || 4; });
  });
}

export function addConfigAndFocus() {
  if (state.sagemakerEndpoints.length === 0) {
    switchView("endpoints");
    return;
  }
  const c = state.addConfig();
  if (!c.label) c.label = state.HOMEPAGE_LABELS[0];
  renderStart();
  switchView("start");
}

// ---------- Endpunkte (reine SageMaker-Endpunkte) ----------

function renderEndpoints() {
  const el = document.getElementById("endpointCards");
  el.innerHTML = state.sagemakerEndpoints.map(ep => `
    <div class="card" data-endpoint="${ep.id}">
      <div class="cardHead">
        <h3 style="flex:none">Endpunkt</h3>
        <div style="flex:1"></div>
        <button type="button" class="btn ghost removeEndpoint">✕ Entfernen</button>
      </div>
      <div class="row">
        <div class="field">
          <label for="name-${ep.id}">Name</label>
          <input type="text" id="name-${ep.id}" class="f-name" value="${esc(ep.name)}" placeholder="z.B. SageMaker Prod">
        </div>
        <div class="field apiKeyField">
          <label for="apiKey-${ep.id}">API-Key</label>
          <div class="apiKeyRow">
            <input type="password" id="apiKey-${ep.id}" class="f-apiKey" value="${esc(ep.apiKey)}" placeholder="kein Key = inaktiv">
            <button type="button" class="btn ghost toggleKey" aria-label="API-Key anzeigen">👁</button>
          </div>
        </div>
      </div>
      <div class="field">
        <label for="url-${ep.id}">Endpunkt-URL</label>
        <input type="text" id="url-${ep.id}" class="f-url" value="${esc(ep.url)}" placeholder="https://...">
      </div>
      <div class="testRow">
        <button type="button" class="btn small testConnection">Test Connection</button>
        <span class="testResult"></span>
      </div>
    </div>
  `).join("");

  el.querySelectorAll(".card").forEach(card => {
    const ep = state.sagemakerEndpoints.find(e => e.id === card.dataset.endpoint);

    card.querySelector(".f-name").addEventListener("input", e => { ep.name = e.target.value; });
    card.querySelector(".f-url").addEventListener("input", e => { ep.url = e.target.value; });
    card.querySelector(".f-apiKey").addEventListener("input", e => { ep.apiKey = e.target.value; });
    card.querySelector(".f-name").addEventListener("change", renderStart);

    card.querySelector(".toggleKey").addEventListener("click", () => {
      const input = card.querySelector(".f-apiKey");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      card.querySelector(".toggleKey").setAttribute("aria-label", show ? "API-Key verbergen" : "API-Key anzeigen");
    });

    card.querySelector(".removeEndpoint").addEventListener("click", () => {
      state.removeSagemakerEndpoint(ep.id);
      renderAll();
    });

    card.querySelector(".testConnection").addEventListener("click", async () => {
      const resultEl = card.querySelector(".testResult");
      resultEl.textContent = "Teste …";
      resultEl.classList.remove("error", "ok");
      try {
        const res = await chrome.runtime.sendMessage({
          action: "fetchJson", url: ep.url, token: ep.apiKey,
          body: { body: { history: [state.TEST_CONNECTION_SEED_ID], n_items: 1 }, contentType: "application/json" }
        });
        if (!res || res.error) throw new Error(res?.error || "Unbekannter Fehler");
        resultEl.textContent = "✓ Verbindung OK";
        resultEl.classList.add("ok");
      } catch (e) {
        resultEl.textContent = `✕ ${e.message}`;
        resultEl.classList.add("error");
      }
    });
  });
}

// ---------- History-Presets ----------

function renderHistory() {
  const el = document.getElementById("historyCards");
  el.innerHTML = state.historyPresets.map(p => `
    <div class="card" data-preset="${p.id}">
      <div class="cardHead">
        <h3 style="flex:none">Preset</h3>
        <div style="flex:1"></div>
        <button type="button" class="btn ghost removePreset">✕ Entfernen</button>
      </div>
      <div class="field">
        <label for="presetName-${p.id}">Name</label>
        <input type="text" id="presetName-${p.id}" class="f-name" value="${esc(p.name)}" placeholder="z.B. next-video-v2">
      </div>
      <div class="field">
        <label for="presetIds-${p.id}">Video-IDs (eine pro Zeile)</label>
        <textarea id="presetIds-${p.id}" class="f-ids" placeholder="abc-123&#10;def-456">${esc(p.ids.join("\n"))}</textarea>
      </div>
    </div>
  `).join("");

  el.querySelectorAll(".card").forEach(card => {
    const p = state.historyPresets.find(x => x.id === card.dataset.preset);
    card.querySelector(".f-name").addEventListener("input", e => { p.name = e.target.value; });
    card.querySelector(".f-name").addEventListener("change", renderStart);
    card.querySelector(".f-ids").addEventListener("input", e => {
      p.ids = e.target.value.split("\n").map(s => s.trim()).filter(Boolean);
    });
    card.querySelector(".f-ids").addEventListener("change", renderStart);
    card.querySelector(".removePreset").addEventListener("click", () => {
      state.removeHistoryPreset(p.id);
      renderAll();
    });
  });
}

// ---------- Seitentypen ----------

function renderPageTypes() {
  const el = document.getElementById("pageTypeCards");
  el.innerHTML = state.pageTypes.map(p => `
    <div class="card" data-pagetype="${p.id}">
      <div class="cardHead">
        <h3 style="flex:none">Seitentyp</h3>
        <div style="flex:1"></div>
        <button type="button" class="btn ghost removePageType">✕ Entfernen</button>
      </div>
      <div class="row">
        <div class="field">
          <label for="ptName-${p.id}">Name</label>
          <input type="text" id="ptName-${p.id}" class="f-name" value="${esc(p.name)}" placeholder="z.B. Video">
        </div>
        <div class="field">
          <label for="ptMarker-${p.id}">GraphQL-Feld</label>
          <input type="text" id="ptMarker-${p.id}" class="f-marker" value="${esc(p.marker)}" placeholder="z.B. videoByCanonical">
        </div>
      </div>
      <p class="hint">Root-Query-Feld, das $canonical als Argument nimmt (z.B. videoByCanonical). Die Extension probiert bei jeder Seite alle konfigurierten Felder durch — welches nicht null liefert, ist der Seitentyp. Unbekannte Felder werden automatisch per Introspection gelernt und hier ergänzt.</p>
    </div>
  `).join("");

  el.querySelectorAll(".card").forEach(card => {
    const p = state.pageTypes.find(x => x.id === card.dataset.pagetype);
    card.querySelector(".f-name").addEventListener("input", e => { p.name = e.target.value; });
    card.querySelector(".f-name").addEventListener("change", renderJsonTemplates);
    card.querySelector(".f-marker").addEventListener("input", e => { p.marker = e.target.value; });
    card.querySelector(".removePageType").addEventListener("click", () => {
      state.removePageType(p.id);
      renderAll();
    });
  });
}

// ---------- JSON-Templates ----------

// ---------- Query-Referenz (Wiki-Panel) ----------

function renderQueryReference() {
  const el = document.getElementById("queryReference");
  if (!el) return;

  el.innerHTML = state.QUERY_REFERENCE.map((ref, i) => `
    <div class="refBlock" data-ref="${i}">
      <h3>${esc(ref.name)}</h3>
      <pre>${esc(ref.query.trim())}</pre>
      <button type="button" class="btn small copyRef">Kopieren</button>
    </div>
  `).join("");

  el.querySelectorAll(".refBlock").forEach(block => {
    const ref = state.QUERY_REFERENCE[Number(block.dataset.ref)];
    const btn = block.querySelector(".copyRef");
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(ref.query.trim());
        btn.textContent = "Kopiert ✓";
      } catch {
        btn.textContent = "Kopieren fehlgeschlagen";
      }
      setTimeout(() => { btn.textContent = "Kopieren"; }, 1500);
    });
  });
}

function renderJsonTemplates() {
  const el = document.getElementById("jsonTemplateCards");
  const pageTypeOptions = `<option value="">(alle Seitentypen)</option>` +
    state.pageTypes.map(p => `<option value="${p.id}">${esc(p.name) || "(ohne Namen)"}</option>`).join("");

  el.innerHTML = state.jsonTemplates.map(t => `
    <div class="card" data-template="${t.id}">
      <div class="cardHead">
        <h3 style="flex:none">Template</h3>
        <div style="flex:1"></div>
        <button type="button" class="btn ghost removeTemplate">✕ Entfernen</button>
      </div>
      <div class="row">
        <div class="field">
          <label for="tplName-${t.id}">Name (Menütitel)</label>
          <input type="text" id="tplName-${t.id}" class="f-name" value="${esc(t.name)}" placeholder="z.B. Video-Basisdaten">
        </div>
        <div class="field">
          <label for="tplPageType-${t.id}">Seitentyp</label>
          <select id="tplPageType-${t.id}" class="f-pageType">${pageTypeOptions}</select>
        </div>
      </div>
      <div class="field">
        <label for="tplQuery-${t.id}">GraphQL-Query</label>
        <textarea id="tplQuery-${t.id}" class="f-query" style="min-height:10rem" placeholder="query VideoByCanonical($canonical: String!, $first: Int) { ... }">${esc(t.query)}</textarea>
      </div>
    </div>
  `).join("");

  state.jsonTemplates.forEach(t => {
    document.getElementById(`tplPageType-${t.id}`).value = t.pageTypeId || "";
  });

  el.querySelectorAll(".card").forEach(card => {
    const t = state.jsonTemplates.find(x => x.id === card.dataset.template);
    card.querySelector(".f-name").addEventListener("input", e => { t.name = e.target.value; });
    card.querySelector(".f-pageType").addEventListener("change", e => { t.pageTypeId = e.target.value || null; });
    card.querySelector(".f-query").addEventListener("input", e => { t.query = e.target.value; });
    card.querySelector(".removeTemplate").addEventListener("click", () => {
      state.removeJsonTemplate(t.id);
      renderJsonTemplates();
    });
  });
}

// ---------- A/B-Gruppe überschreiben ----------

function renderAbGroup() {
  const el = document.getElementById("abGroupCard");
  if (!el) return;

  const groupList = state.abGroups.length === 0
    ? `<p class="hint">Noch keine Gruppen geladen.</p>`
    : `<ul class="hint" style="margin:0;padding-left:1.2rem;">${state.abGroups.map(g =>
        `<li>${esc(g.name)}${g.probability != null ? ` (${g.probability}%)` : ""}</li>`).join("")}</ul>`;

  el.innerHTML = `
    <p class="hint">Verfügbare Gruppen — Setzen der Gruppe selbst passiert im Popup auf zdf.de, hier wird nur die Liste aktuell gehalten.</p>
    ${groupList}
    <div class="testRow">
      <button type="button" class="btn small" id="reloadAbGroups">Gruppen neu laden</button>
      <span class="testResult" id="abGroupReloadResult"></span>
    </div>
  `;

  document.getElementById("reloadAbGroups").addEventListener("click", async () => {
    const resultEl = document.getElementById("abGroupReloadResult");
    resultEl.textContent = "Lädt …";
    resultEl.classList.remove("error", "ok");
    try {
      await state.fetchAbGroups();
      resultEl.textContent = "✓ Geladen";
      resultEl.classList.add("ok");
      renderAbGroup();
    } catch (e) {
      resultEl.textContent = `✕ ${e.message}`;
      resultEl.classList.add("error");
    }
  });
}

// ---------- Nav ----------

export function switchView(name) {
  document.querySelectorAll(".navBtn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === `view-${name}`));
  if (location.hash.slice(1) !== name) location.hash = name;
}

export function showStatus(elId, ok, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.classList.toggle("error", !ok);
  setTimeout(() => { el.textContent = ""; }, ok ? 2000 : 5000);

  const btn = document.getElementById(elId.replace("status", "save"));
  if (btn) {
    const flashClass = ok ? "flash-ok" : "flash-error";
    btn.classList.remove("flash-ok", "flash-error");
    void btn.offsetWidth; // Reflow erzwingen, damit die Klasse bei schnellem erneutem Klick neu greift
    btn.classList.add(flashClass);
    setTimeout(() => btn.classList.remove(flashClass), ok ? 1200 : 2000);
  }
}
