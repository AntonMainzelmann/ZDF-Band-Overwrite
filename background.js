// ZDF Band Overwrite — Background Script
// Reagiert auf Klicks auf das Action-Icon (Toolbar-Button) und toggelt den Overwrite-Status.
// Zustand liegt in chrome.storage.local, da der Service Worker jederzeit terminiert
// und neu geladene Seiten den aktuellen Status selbst abfragen (siehe main.js).

async function getIsActive() {
  const { isActive } = await chrome.storage.local.get("isActive");
  return isActive !== false; // Default: aktiv
}

function setBadge(isActive) {
  chrome.action.setBadgeText({ text: isActive ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: isActive ? "#FF6600" : "#777777" });
}

getIsActive().then(setBadge);

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  const isActive = !(await getIsActive());
  await chrome.storage.local.set({ isActive });
  setBadge(isActive);

  chrome.tabs.sendMessage(tab.id, { action: "toggleOverwrite", forceState: isActive })
    .catch((err) => {
      // Tritt auf, wenn auf einer Seite geklickt wird, auf der main.js nicht aktiv ist.
      console.log("[overwrite-bg] Nachricht konnte nicht gesendet werden (kein Content-Script aktiv):", err.message);
    });
});
