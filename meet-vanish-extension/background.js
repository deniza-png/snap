"use strict";

const OWNER_KEY = "meetVanishGestureTabOwners";
const PERSON_OWNER_KEY = "meetVanishPersonTabOwners";
let lifecycleQueue = Promise.resolve();

function queueLifecycle(task) {
  lifecycleQueue = lifecycleQueue.catch(() => {}).then(task);
  return lifecycleQueue;
}

async function getGestureOwners(key = OWNER_KEY) {
  const values = await chrome.storage.session.get({ [key]: [] });
  return new Set((values[key] || []).filter(Number.isInteger));
}

async function registerGestureTab(tabId, key = OWNER_KEY) {
  const owners = await getGestureOwners(key);
  owners.add(tabId);
  await chrome.storage.session.set({ [key]: [...owners] });
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("gesture-offscreen.html")]
  });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: "gesture-offscreen.html",
      reasons: ["BLOBS"],
      justification: "Decode temporary local camera JPEG blobs for on-device hand and person recognition."
    });
  }
}

async function releaseGestureTab(tabId, key = OWNER_KEY) {
  const owners = await getGestureOwners(key);
  if (!owners.delete(tabId)) return; // An unrelated tab must never close the shared model.
  await chrome.storage.session.set({ [key]: [...owners] });
  if (owners.size || (await getGestureOwners(key === OWNER_KEY ? PERSON_OWNER_KEY : OWNER_KEY)).size) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Closing an already-closed offscreen document is harmless.
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  queueLifecycle(async () => {
    await releaseGestureTab(tabId);
    await releaseGestureTab(tabId, PERSON_OWNER_KEY);
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (typeof changes.url === "string" && !changes.url.startsWith("https://meet.google.com/")) {
    queueLifecycle(async () => {
      await releaseGestureTab(tabId);
      await releaseGestureTab(tabId, PERSON_OWNER_KEY);
    }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "MEET_VANISH_OFFSCREEN") return false;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
      !sender.tab.url?.startsWith("https://meet.google.com/")) return false;
  if (message?.type === "MEET_VANISH_GESTURE_CONTROL" ||
      message?.type === "MEET_VANISH_PERSON_CONTROL") {
    if (typeof message.enabled !== "boolean") return false;
    const key = message.type === "MEET_VANISH_PERSON_CONTROL" ? PERSON_OWNER_KEY : OWNER_KEY;
    queueLifecycle(async () => {
      if (message.enabled) await registerGestureTab(sender.tab.id, key);
      else await releaseGestureTab(sender.tab.id, key);
      return { ok: true };
    }).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  const isPerson = message?.type === "MEET_VANISH_PERSON_FRAME";
  if (!isPerson && message?.type !== "MEET_VANISH_GESTURE_FRAME") return false;
  if (typeof message.image !== "string" || message.image.length > 250_000 ||
      !message.image.startsWith("data:image/jpeg;base64,")) {
    sendResponse({ ok: false, error: "Invalid camera sample." });
    return false;
  }
  queueLifecycle(async () => {
    try {
      // Owners survive MV3 service-worker suspension in session storage.
      // Creation, inference, closure, and re-enabling share one serialized queue.
      const owners = await getGestureOwners();
      if (!isPerson && !owners.has(sender.tab.id)) return { ok: true, skipped: true };
      await ensureOffscreen();
      const result = await chrome.runtime.sendMessage({
        target: "MEET_VANISH_OFFSCREEN",
        type: isPerson ? "SEGMENT_PERSON" : "DETECT_V_SIGN",
        image: message.image
      });
      return result || { ok: false, error: "Hand detector did not respond." };
    } catch (error) {
      console.warn("[Meet Vanish] Gesture engine unavailable.", error);
      return { ok: false, error: "Hand model unavailable. Reload the extension and Meet." };
    } finally {
      // A one-shot person request does not register a continuous camera owner.
      // Close its model document only after inference, under the same queue.
      if (isPerson) {
        try {
          if ((await getGestureOwners()).size === 0 &&
              (await getGestureOwners(PERSON_OWNER_KEY)).size === 0) await chrome.offscreen.closeDocument();
        } catch {}
      }
    }
  }).then(sendResponse, () => sendResponse({ ok: false, error: "Hand detector unavailable." }));
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-vanish") return;

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });
    if (!tab?.id || !tab.url?.startsWith("https://meet.google.com/")) return;
    await chrome.tabs.sendMessage(tab.id, { type: "MEET_VANISH_TOGGLE" });
  } catch (error) {
    console.debug("[Meet Vanish] Shortcut unavailable on this tab.", error);
  }
});