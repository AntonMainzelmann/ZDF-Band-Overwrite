import * as state from "./state.js";
import { renderAll, switchView, showStatus, addConfigAndFocus } from "./ui.js";

document.querySelectorAll(".navBtn").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

document.getElementById("addConfig").addEventListener("click", addConfigAndFocus);

document.getElementById("addEndpoint").addEventListener("click", () => {
  state.addSagemakerEndpoint();
  renderAll();
  switchView("endpoints");
});

document.getElementById("addHistoryPreset").addEventListener("click", () => {
  state.addHistoryPreset();
  renderAll();
  switchView("history");
});

document.getElementById("addJsonTemplate").addEventListener("click", () => {
  state.addJsonTemplate();
  renderAll();
  switchView("jsonTemplates");
});

document.getElementById("addPageType").addEventListener("click", () => {
  state.addPageType();
  renderAll();
  switchView("pageTypes");
});

async function saveAndReport(statusElId) {
  const { ok, errors } = await state.save();
  if (!ok) {
    showStatus(statusElId, false, errors[0]);
    return;
  }
  renderAll();
  showStatus(statusElId, true, "Gespeichert.");
}

document.getElementById("save1").addEventListener("click", () => saveAndReport("status1"));
document.getElementById("save2").addEventListener("click", () => saveAndReport("status2"));
document.getElementById("save3").addEventListener("click", () => saveAndReport("status3"));
document.getElementById("save4").addEventListener("click", () => saveAndReport("status4"));
document.getElementById("save5").addEventListener("click", () => saveAndReport("status5"));

function viewFromHash() {
  const name = location.hash.slice(1);
  const valid = [...document.querySelectorAll(".navBtn")].some(b => b.dataset.view === name);
  return valid ? name : "start";
}
window.addEventListener("hashchange", () => switchView(viewFromHash()));

document.getElementById("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.exportSnapshot(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `zdf-band-overwrite-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importBtn").addEventListener("click", () => {
  document.getElementById("importInput").click();
});

document.getElementById("importInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    state.importSnapshot(JSON.parse(await file.text()));
    renderAll();
    alert("Import erfolgreich geladen. Zum Übernehmen jetzt auf einer der Seiten „Speichern“ klicken.");
  } catch (err) {
    alert(`Import fehlgeschlagen: ${err.message}`);
  }
});

document.getElementById("versionLabel").textContent = `v${chrome.runtime.getManifest().version}`;

(async () => {
  await state.loadState();
  renderAll();
  switchView(viewFromHash());
})();
