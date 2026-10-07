"use strict";

(() => {
  const TYPE = "MEET_VANISH_BRIDGE_V1";
  const defaults = {
    enabled: true,
    background: "",
    panelPosition: null,
    sensitivity: "medium",
    thanos: false,
    gesture: false
  };
  let prefs = { ...defaults };

  function validImage(value) {
    return typeof value === "string" &&
      value.startsWith("data:image/jpeg;base64,") &&
      value.length <= 7_500_000;
  }

  function sendConfig() {
    window.postMessage({
      type: TYPE,
      action: "CONFIG",
      payload: { ...prefs }
    }, location.origin);
  }

  function loadPrefs() {
    chrome.storage.local.get(defaults, (items) => {
      if (chrome.runtime.lastError) {
        console.warn("[Meet Vanish] Could not load settings.", chrome.runtime.lastError);
        sendConfig();
        return;
      }
      prefs = {
        enabled: items.enabled !== false,
        background: validImage(items.background) ? items.background : "",
        panelPosition: items.panelPosition &&
          Number.isFinite(items.panelPosition.left) &&
          Number.isFinite(items.panelPosition.top)
          ? {
              left: Math.round(items.panelPosition.left),
              top: Math.round(items.panelPosition.top)
            }
          : null,
        sensitivity: ["low", "medium", "high"].includes(items.sensitivity)
          ? items.sensitivity
          : "medium",
        thanos: items.thanos === true,
        gesture: items.gesture === true
      };
      sendConfig();
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.type !== TYPE || typeof message.action !== "string") return;

    if (message.action === "GESTURE_CONTROL" || message.action === "PERSON_CONTROL") {
      if (typeof message.payload?.enabled !== "boolean") return;
      chrome.runtime.sendMessage({
        type: message.action === "PERSON_CONTROL" ? "MEET_VANISH_PERSON_CONTROL" : "MEET_VANISH_GESTURE_CONTROL",
        enabled: message.payload.enabled
      }).catch(() => {});
      return;
    }
    if (message.action === "PERSON_FRAME") {
      const payload = message.payload;
      if (!payload || typeof payload.image !== "string" ||
          !payload.image.startsWith("data:image/jpeg;base64,") || payload.image.length > 250_000 ||
          !Number.isSafeInteger(payload.requestId)) return;
      chrome.runtime.sendMessage({
        type: "MEET_VANISH_PERSON_FRAME", image: payload.image
      }).then((result) => {
        window.postMessage({
          type: TYPE, action: "PERSON_RESULT",
          payload: {
            requestId: payload.requestId,
            ok: result?.ok === true,
            width: result?.width, height: result?.height,
            mask: typeof result?.mask === "string" && result.mask.length <= 350_000 ? result.mask : ""
          }
        }, location.origin);
      }).catch(() => {
        window.postMessage({
          type: TYPE, action: "PERSON_RESULT",
          payload: { requestId: payload.requestId, ok: false }
        }, location.origin);
      });
      return;
    }
    if (message.action === "GESTURE_FRAME") {
      const payload = message.payload;
      if (!payload || typeof payload.image !== "string" ||
          !payload.image.startsWith("data:image/jpeg;base64,") || payload.image.length > 250_000 ||
          !Number.isSafeInteger(payload.requestId) || !Number.isSafeInteger(payload.generation)) return;
      chrome.runtime.sendMessage({
        type: "MEET_VANISH_GESTURE_FRAME",
        image: payload.image
      }).then((result) => {
        window.postMessage({
          type: TYPE, action: "GESTURE_RESULT",
          payload: {
            requestId: payload.requestId,
            generation: payload.generation,
            ok: result?.ok === true,
            isV: result?.isV === true,
            handPresent: result?.handPresent === true,
            skipped: result?.skipped === true,
            error: result?.ok === true ? "" : "Hand detector unavailable. Reload extension and Meet."
          }
        }, location.origin);
      }).catch(() => {
        window.postMessage({
          type: TYPE, action: "GESTURE_RESULT",
          payload: {
            requestId: payload.requestId, generation: payload.generation,
            ok: false, error: "Hand detector unavailable. Reload extension and Meet."
          }
        }, location.origin);
      });
      return;
    }

    if (message.action === "SAVE_BACKGROUND") {
      const image = message.payload?.image;
      if (!validImage(image)) return;
      prefs.background = image;
      chrome.storage.local.set({ background: image }, () => {
        if (chrome.runtime.lastError) {
          console.warn("[Meet Vanish] Could not save the background.", chrome.runtime.lastError);
        }
      });
      return;
    }

    if (message.action === "SAVE_PREFS") {
      const payload = message.payload;
      if (!payload || typeof payload !== "object") return;
      const patch = {};

      if (typeof payload.panelPosition?.left === "number" &&
          Number.isFinite(payload.panelPosition.left) &&
          typeof payload.panelPosition?.top === "number" &&
          Number.isFinite(payload.panelPosition.top)) {
        patch.panelPosition = {
          left: Math.round(payload.panelPosition.left),
          top: Math.round(payload.panelPosition.top)
        };
      }
      if (["low", "medium", "high"].includes(payload.sensitivity)) {
        patch.sensitivity = payload.sensitivity;
      }
      if (typeof payload.thanos === "boolean") patch.thanos = payload.thanos;
      if (typeof payload.gesture === "boolean") patch.gesture = payload.gesture;

      prefs = { ...prefs, ...patch };
      if (Object.keys(patch).length) chrome.storage.local.set(patch);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key of ["enabled", "background", "panelPosition", "sensitivity", "thanos", "gesture"]) {
      if (!changes[key]) continue;
      const value = changes[key].newValue;
      if (key === "background") prefs.background = validImage(value) ? value : "";
      else if (key === "enabled") prefs.enabled = value !== false;
      else if (key === "panelPosition") {
        prefs.panelPosition = value &&
          Number.isFinite(value.left) && Number.isFinite(value.top)
          ? { left: Math.round(value.left), top: Math.round(value.top) }
          : null;
      } else if (key === "sensitivity") {
        prefs.sensitivity = ["low", "medium", "high"].includes(value) ? value : "medium";
      } else if (key === "thanos") {
        prefs.thanos = value === true;
      } else if (key === "gesture") {
        prefs.gesture = value === true;
      }
    }
    sendConfig();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "MEET_VANISH_TOGGLE") {
      window.postMessage({ type: TYPE, action: "COMMAND_TOGGLE" }, location.origin);
    }
  });

  window.addEventListener("pagehide", () => {
    chrome.runtime.sendMessage({ type: "MEET_VANISH_GESTURE_CONTROL", enabled: false }).catch(() => {});
    chrome.runtime.sendMessage({ type: "MEET_VANISH_PERSON_CONTROL", enabled: false }).catch(() => {});
  });
  loadPrefs();
})();