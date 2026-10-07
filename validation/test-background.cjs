"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("meet-vanish-extension/background.js", "utf8");
const OWNER_KEY = "meetVanishGestureTabOwners";
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function environment(shared = { store: {}, document: true }) {
  let listener, removed, updated;
  let closeResolve, detectResolve;
  let deferClose = false;
  let deferDetect = false;
  const stats = { creates: 0, closes: 0, detects: 0 };
  const chrome = {
    commands: { onCommand: { addListener() {} } },
    tabs: {
      onRemoved: { addListener(fn) { removed = fn; } },
      onUpdated: { addListener(fn) { updated = fn; } },
      query: async () => []
    },
    storage: { session: {
      async get(defaults) {
        return { ...defaults, ...Object.fromEntries(Object.entries(shared.store).map(([key, value]) =>
          [key, Array.isArray(value) ? [...value] : value])) };
      },
      async set(values) { Object.assign(shared.store, values); }
    } },
    runtime: {
      id: "test-extension",
      getURL: (name) => `chrome-extension://test-extension/${name}`,
      getContexts: async () => shared.document ? [{}] : [],
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage() {
        stats.detects++;
        if (deferDetect) await new Promise((resolve) => { detectResolve = resolve; });
        return shared.document ? { ok: true, isV: false, handPresent: false } : { ok: false };
      }
    },
    offscreen: {
      async createDocument() { stats.creates++; shared.document = true; },
      async closeDocument() {
        stats.closes++;
        if (deferClose) await new Promise((resolve) => { closeResolve = resolve; });
        shared.document = false;
      }
    }
  };
  const context = vm.createContext({ chrome, console, Set, Number, Promise });
  vm.runInContext(source, context);
  const send = (tabId, message) => new Promise((resolve, reject) => {
    const accepted = listener(message, {
      id: chrome.runtime.id, tab: { id: tabId, url: "https://meet.google.com/test-call" }
    }, resolve);
    if (!accepted && message.type !== "MEET_VANISH_GESTURE_CONTROL") {
      // A synchronous response is allowed; invalid sender cases are outside these tests.
    }
  });
  return {
    stats, shared,
    control: (tabId, enabled) => send(tabId, { type: "MEET_VANISH_GESTURE_CONTROL", enabled }),
    personControl: (tabId, enabled) => send(tabId, {type:"MEET_VANISH_PERSON_CONTROL",enabled}),
    frame: (tabId) => send(tabId, { type: "MEET_VANISH_GESTURE_FRAME", image: "data:image/jpeg;base64,AAAA" }),
    person: (tabId) => send(tabId, { type: "MEET_VANISH_PERSON_FRAME", image: "data:image/jpeg;base64,AAAA" }),
    remove: (tabId) => removed(tabId),
    navigate: (tabId, url) => updated(tabId, { url }),
    idle: () => context.queueLifecycle(async () => {}),
    delayClose() { deferClose = true; },
    finishClose() { deferClose = false; closeResolve(); },
    delayDetect() { deferDetect = true; },
    finishDetect() { deferDetect = false; detectResolve(); }
  };
}

(async () => {
  let passed = 0;
  const test = async (name, fn) => {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  };
  await test("rapid disable/re-enable waits for deferred close before creating a new document", async () => {
    const env = environment();
    await env.control(1, true);
    env.delayClose();
    const off = env.control(1, false);
    await flush();
    assert.equal(env.stats.closes, 1);
    const on = env.control(1, true);
    const frame = env.frame(1);
    await flush();
    assert.equal(env.stats.creates, 0);
    env.finishClose();
    await Promise.all([off, on]);
    assert.equal((await frame).ok, true);
    assert.equal(env.stats.creates, 1);
  });
  await test("worker restart retains owners and unrelated tab closure does not close the model", async () => {
    const shared = { store: {}, document: true };
    const first = environment(shared);
    await first.control(1, true);
    const restarted = environment(shared);
    restarted.remove(99);
    await restarted.idle();
    assert.equal(restarted.stats.closes, 0);
    assert.equal((await restarted.frame(1)).ok, true);
    assert.deepEqual(Array.from(shared.store[OWNER_KEY]), [1]);
  });
  await test("two tabs share model; only the final owner closes it", async () => {
    const env = environment();
    await env.control(1, true);
    await env.control(2, true);
    await env.control(1, false);
    assert.equal(env.stats.closes, 0);
    assert.equal((await env.frame(2)).ok, true);
    await env.control(2, false);
    assert.equal(env.stats.closes, 1);
  });
  await test("document is not closed in the middle of a frame inference", async () => {
    const env = environment();
    await env.control(1, true);
    env.delayDetect();
    const frame = env.frame(1);
    await flush();
    const off = env.control(1, false);
    await flush();
    assert.equal(env.stats.closes, 0);
    env.finishDetect();
    assert.equal((await frame).ok, true);
    await off;
    assert.equal(env.stats.closes, 1);
  });
  await test("navigation away releases its owner; unregistered frames never reopen the model", async () => {
    const env = environment();
    await env.control(1, true);
    env.navigate(1, "https://example.com/");
    await env.idle();
    assert.equal(env.stats.closes, 1);
    const frame = await env.frame(1);
    assert.equal(frame.skipped, true);
    assert.equal(env.stats.creates, 0);
  });
  await test("one-shot person inference closes an unused model document but preserves gesture owners", async () => {
    const env = environment();
    assert.equal((await env.person(1)).ok, true);
    assert.equal(env.stats.closes, 1);
    await env.control(2, true);
    assert.equal((await env.person(1)).ok, true);
    assert.equal(env.stats.creates, 1);
    assert.equal(env.stats.closes, 1);
    assert.equal((await env.frame(2)).ok, true);
  });
  await test("live dust keeps its model warm without V detection and releases it after its final owner", async () => {
    const env = environment();
    await env.personControl(1, true);
    await env.person(1); await env.person(1);
    assert.equal(env.stats.closes, 0);
    await env.control(2, true);
    await env.control(2, false);
    assert.equal(env.stats.closes, 0); // Dust still owns the shared document.
    await env.personControl(1, false);
    assert.equal(env.stats.closes, 1);
  });
  await test("worker restart and tab closure release persistent live-dust ownership", async () => {
    const shared = {store:{},document:true};
    const env = environment(shared);
    await env.personControl(1,true);
    const restarted = environment(shared);
    await restarted.person(1);
    assert.equal(restarted.stats.closes,0);
    restarted.remove(1); await restarted.idle();
    assert.equal(restarted.stats.closes,1);
  });
  console.log(`\n${passed}/${passed} background lifecycle tests passed.`);
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });