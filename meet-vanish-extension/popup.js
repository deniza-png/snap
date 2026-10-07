"use strict";

const enabledInput = document.getElementById("enabled");
const notice = document.getElementById("notice");

chrome.storage.local.get({ enabled: true }, (items) => {
  enabledInput.checked = items.enabled !== false;
});

enabledInput.addEventListener("change", () => {
  const enabled = enabledInput.checked;
  chrome.storage.local.set({ enabled }, () => {
    if (chrome.runtime.lastError) {
      enabledInput.checked = !enabled;
      notice.textContent = "Could not save this setting.";
      notice.classList.add("error");
      return;
    }
    notice.classList.remove("error");
    notice.textContent = enabled
      ? "Enabled. Open or refresh Meet to use the controls."
      : "Disabled. Existing calls may need a camera reconnect to restore the direct feed.";
  });
});