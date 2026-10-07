"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  dispatch(name) {
    for (const fn of [...(this.listeners.get(name) || [])]) fn({ type: name });
  }
}

class Track extends Events {
  constructor(kind, source = "raw") {
    super();
    this.kind = kind;
    this.source = source;
    this.enabled = true;
    this.muted = false;
    this.readyState = "live";
  }
  stop() { this.readyState = "ended"; }
  clone() {
    const clone = new Track(this.kind, this.source);
    clone.readyState = this.readyState;
    clone.enabled = this.enabled;
    return clone;
  }
  getSettings() { return { width: 640, height: 480 }; }
}

class Stream {
  constructor(tracks) { this.tracks = tracks || []; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  clone() {
    // Model a browser-native stream clone that bypasses own track.clone overrides.
    return new Stream(this.tracks.map((track) => Track.prototype.clone.call(track)));
  }
}

class Element extends Events {
  constructor(tag) {
    super();
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.id = "";
    this.className = "";
    this.classList = {
      toggle: (name, enabled) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
      },
      remove: (name) => {
        this.className = this.className.split(/\s+/).filter((item) => item !== name).join(" ");
      }
    };
  }
  set innerHTML(value) { throw new TypeError("TrustedHTML assignment required"); }
  setAttribute(key, value) {
    if (key === "class") this.className = value;
    else this[key] = value;
  }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  attachShadow() { this.shadowRoot = new Element("#shadow-root"); return this.shadowRoot; }
  querySelector(selector) {
    const id = selector.slice(1);
    for (const child of this.children) {
      if (child.id === id) return child;
      const descendant = child.querySelector?.(selector);
      if (descendant) return descendant;
    }
    return null;
  }
  getBoundingClientRect() { return { left: 20, top: 20, width: 286, height: 340 }; }
}

function setup(options = {}) {
  let time = 0;
  let serial = 0;
  const intervals = new Map();
  const rafs = new Map();
  const timeouts = new Map();
  const videos = [];
  const audioContexts = [];
  const rawVideo = new Track("video");
  const rawAudio = new Track("audio");
  const rawStream = new Stream([rawVideo, rawAudio]);
  let rms = 0.003;
  let micResolve;
  const mic = new Track("audio", "detector");
  const requests = [];
  const postedMessages = [];
  const drawSources = [];
  const dustEffects = [];
  const window = new Events();
  Object.assign(window, {
    innerWidth: 1280,
    innerHeight: 720,
    postMessage(message) { postedMessages.push(message); },
    setInterval(fn, ms) { const id = ++serial; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) { const id = ++serial; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    requestAnimationFrame(fn) { const id = ++serial; rafs.set(id, fn); return id; },
    cancelAnimationFrame(id) { rafs.delete(id); }
  });
  const document = new Events();
  document.documentElement = null; // Avoid creating the UI; test the real media code.
  if (options.ui) {
    document.documentElement = new Element("html");
    document.body = new Element("body");
    document.documentElement.appendChild(document.body);
  }
  document.createTextNode = (text) => {
    const node = new Element("#text");
    node.textContent = text;
    return node;
  };
  document.visibilityState = "visible";
  document.createElement = (name) => {
    if (name === "canvas") {
      return {
        width: 640,
        height: 480,
        getContext() {
          return {
            globalAlpha: 1,
            drawImage(source) {
              drawSources.push(source);
              if (options.drawFails) throw new Error("draw failed");
            },
            save() {},
            restore() {}
          };
        },
        captureStream() {
          if (options.canvasFails) throw new Error("capture unavailable");
          return new Stream([new Track("video", "canvas")]);
        },
        toDataURL() { return "data:image/jpeg;base64,TEST"; }
      };
    }
    if (name === "video") {
      const video = new Events();
      Object.assign(video, {
        readyState: options.videoNeverReady ? 0 : 2,
        videoWidth: options.videoNeverReady ? 0 : 640,
        videoHeight: options.videoNeverReady ? 0 : 480,
        style: {},
        removed: false,
        play() { return options.playFails ? Promise.reject(new Error("play failed")) : Promise.resolve(); },
        pause() {},
        remove() { video.removed = true; }
      });
      videos.push(video);
      return video;
    }
    if (options.ui) return new Element(name);
    throw new Error(`Unexpected element: ${name}`);
  };
  class AudioContext {
    constructor() { this.state = "running"; audioContexts.push(this); }
    createMediaStreamSource(stream) {
      this.input = stream.getAudioTracks()[0];
      if (options.sourceFails) throw new Error("source setup failed");
      return { connect() {}, disconnect() {} };
    }
    createBiquadFilter() {
      return { type: "", frequency: { value: 0 }, Q: { value: 0 }, connect() {}, disconnect() {} };
    }
    createAnalyser() {
      return { fftSize: 1024, getFloatTimeDomainData(array) { array.fill(rms); }, disconnect() {} };
    }
    resume() { return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  window.AudioContext = AudioContext;
  const devices = {
    getUserMedia(constraints) {
      requests.push(constraints);
      if (options.permissionFails) return Promise.reject(options.permissionFails);
      if (!constraints.video) {
        if (options.pendingMic) return new Promise((resolve) => { micResolve = resolve; });
        return Promise.resolve(new Stream([mic]));
      }
      return Promise.resolve(options.videoStreams?.shift() || rawStream);
    }
  };
  class Image {
    set src(value) { queueMicrotask(() => this.onload?.()); }
  }
  const context = vm.createContext({
    window, document, navigator: { mediaDevices: devices },
    location: { origin: "https://meet.google.com" },
    console: { debug() {}, warn() {} },
    MediaStream: Stream, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    Float32Array, Uint8Array, atob, Image, performance: { now: () => time },
    MeetVanishDust: options.dust ? {
      duration: 2200,
      prepare(args) {
        const effect = {
          args, phases: [], disposed: false,
          render(context, phase) { this.phases.push(phase); },
          dispose() { this.disposed = true; }
        };
        if (options.liveDust) {
          effect.updates = [];
          effect.updatePersonMask = (mask) => {
            effect.updates.push(mask);
            if(options.dustReadyGate || options.reusableDust) effect.ready=true;
          };
        }
        if(options.dustReadyGate || options.reusableDust) effect.ready=Boolean(args.personMask);
        if(options.reusableDust) {
          effect.canReset=true;effect.resets=0;effect.warms=0;
          effect.reset=(mask,returning)=>{
            effect.resets++;effect.ready=Boolean(mask);effect.returning=returning;return effect.ready;
          };
          effect.setReturning=value=>{effect.returning=value;};
          effect.warmup=()=>{effect.warms++;};
        }
        dustEffects.push(effect);
        return effect;
      }
    } : undefined,
    createImageBitmap: async () => ({ close() {} })
  });
  if(options.reusableDust) context.MeetVanishDust.prewarm=context.MeetVanishDust.prepare;
  vm.runInContext(fs.readFileSync("meet-vanish-extension/gesture-rules.js", "utf8"), context);
  let code = fs.readFileSync("meet-vanish-extension/main-world.js", "utf8");
  code = code.replace(/\}\)\(\);\s*$/, `
    globalThis.__test = {
      state, toggleSnap, stopSnapDetection, setVanished, handleBridgeMessage,
      loadBackground, toggleGesture, sampleGestureFrame, handleGestureResult
    };
  })();`);
  vm.runInContext(code, context);
  return {
    api: context.__test, devices, rawStream, rawVideo, rawAudio, videos,
    intervals, rafs, timeouts, document, window, mic, requests, audioContexts,
    postedMessages, drawSources, dustEffects,
    respondPerson(requestId = postedMessages.filter((message) => message.action === "PERSON_FRAME").at(-1)?.payload.requestId) {
      context.__test.handleBridgeMessage({
        source: window, origin: "https://meet.google.com",
        data: { type: "MEET_VANISH_BRIDGE_V1", action: "PERSON_RESULT",
          payload: {requestId, ok:true,width:4,height:4,mask:Buffer.alloc(16,255).toString("base64")} }
      });
    },
    resolveMic() { micResolve(new Stream([mic])); },
    tick(value, ms = 20) {
      rms = value;
      time += ms;
      for (const entry of [...intervals.values()]) entry.fn();
    },
    frame() {
      time += 16;
      const pending = [...rafs.entries()];
      for (const [id, fn] of pending) { rafs.delete(id); fn(); }
    },
    configure(values) {
      context.__test.handleBridgeMessage({
        source: window,
        origin: "https://meet.google.com",
        data: {
          type: "MEET_VANISH_BRIDGE_V1",
          action: "CONFIG",
          payload: { enabled: true, background: "", ...values }
        }
      });
    }
  };
}

async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("floating panel initializes when HTML string sinks are blocked", async () => {
  const env = setup({ ui: true });
  const host = env.api.state.panel;
  assert.ok(host);
  assert.equal(host.parent, env.document.body);
  const root = host.shadowRoot;
  assert.equal(root.querySelector("#capture").textContent, "Capture empty room");
  assert.equal(root.querySelector("#toggle").disabled, true);
  assert.equal(root.querySelector("#snap").disabled, true);
  assert.equal(host.style.display, "block");
  env.configure({ enabled: false });
  assert.equal(host.style.display, "none");
  env.configure({ enabled: true });
  assert.equal(host.style.display, "block");
});

test("document_start wrapper replaces video and preserves original audio identity", async () => {
  const env = setup();
  const stream = await env.devices.getUserMedia({ video: true, audio: true });
  assert.notEqual(stream.getVideoTracks()[0], env.rawVideo);
  assert.equal(stream.getAudioTracks()[0], env.rawAudio);
  assert.equal(env.api.state.pipelines.size, 1);
});

test("native camera rejection propagates unchanged", async () => {
  const error = new Error("permission denied");
  const env = setup({ permissionFails: error });
  await assert.rejects(env.devices.getUserMedia({ video: true }), (received) => received === error);
});

test("disabled extension returns the native stream without allocating a pipeline", async () => {
  const env = setup();
  env.configure({ enabled: false });
  assert.equal(await env.devices.getUserMedia({ video: true }), env.rawStream);
  assert.equal(env.api.state.pipelines.size, 0);
});

test("camera switches allocate independent pipelines and clean them independently", async () => {
  const firstCamera = new Track("video");
  const nextCamera = new Track("video");
  const env = setup({ videoStreams: [
    new Stream([firstCamera]), new Stream([nextCamera])
  ] });
  const first = await env.devices.getUserMedia({ video: true });
  const next = await env.devices.getUserMedia({ video: true });
  assert.equal(env.api.state.pipelines.size, 2);
  first.getVideoTracks()[0].stop();
  assert.equal(firstCamera.readyState, "ended");
  assert.equal(nextCamera.readyState, "live");
  next.getVideoTracks()[0].stop();
  assert.equal(nextCamera.readyState, "ended");
  assert.equal(env.api.state.pipelines.size, 0);
});

for (const option of ["canvasFails", "playFails", "drawFails"]) {
  test(`${option}: rollback returns untouched camera stream with no extension resources`, async () => {
    const env = setup({ [option]: true });
    assert.equal(await env.devices.getUserMedia({ video: true }), env.rawStream);
    assert.equal(env.rawVideo.readyState, "live");
    assert.equal(env.rawAudio.readyState, "live");
    assert.equal(env.api.state.pipelines.size, 0);
    assert.equal(env.intervals.size + env.rafs.size, 0);
    assert.ok(env.videos.every((video) => video.removed && video.srcObject === null));
  });
}

test("source frame readiness timeout falls back without stopping raw tracks", async () => {
  const env = setup({ videoNeverReady: true });
  const request = env.devices.getUserMedia({ video: true });
  await flush();
  for (const timer of [...env.timeouts.values()]) timer.fn();
  assert.equal(await request, env.rawStream);
  assert.equal(env.rawVideo.readyState, "live");
  assert.equal(env.api.state.pipelines.size, 0);
});

test("stopping returned video releases camera/draw loop but leaves Meet audio untouched", async () => {
  const env = setup();
  const stream = await env.devices.getUserMedia({ video: true, audio: true });
  stream.getVideoTracks()[0].stop();
  assert.equal(env.rawVideo.readyState, "ended");
  assert.equal(env.rawAudio.readyState, "live");
  assert.equal(env.intervals.size + env.rafs.size, 0);
});

for (const viaStream of [false, true]) {
  test(`${viaStream ? "stream" : "track"} clone keeps camera until the final video track stops`, async () => {
    const env = setup();
    const stream = await env.devices.getUserMedia({ video: true, audio: true });
    const original = stream.getVideoTracks()[0];
    const clone = viaStream ? stream.clone().getVideoTracks()[0] : original.clone();
    original.stop();
    assert.equal(env.rawVideo.readyState, "live");
    clone.stop();
    assert.equal(env.rawVideo.readyState, "ended");
    assert.equal(env.rawAudio.readyState, "live");
  });
}

test("raw camera ending stops every tracked output clone", async () => {
  const env = setup();
  const stream = await env.devices.getUserMedia({ video: true });
  const original = stream.getVideoTracks()[0];
  const clone = original.clone();
  env.rawVideo.stop();
  env.rawVideo.dispatch("ended");
  assert.equal(original.readyState, "ended");
  assert.equal(clone.readyState, "ended");
  assert.equal(env.api.state.pipelines.size, 0);
});

test("prototype stop bypass is detected by draw-loop polling", async () => {
  const env = setup();
  const stream = await env.devices.getUserMedia({ video: true });
  Track.prototype.stop.call(stream.getVideoTracks()[0]);
  env.frame();
  assert.equal(env.rawVideo.readyState, "ended");
  assert.equal(env.rafs.size, 0);
});

test("hidden tabs switch from rAF to a timer; visible tabs switch back", async () => {
  const env = setup();
  const stream = await env.devices.getUserMedia({ video: true });
  assert.equal(env.rafs.size, 1);
  assert.equal(env.intervals.size, 0);
  env.document.visibilityState = "hidden";
  env.document.dispatch("visibilitychange");
  assert.equal(env.rafs.size, 0);
  assert.equal(env.intervals.size, 1);
  assert.equal([...env.intervals.values()][0].ms, 33);
  env.document.visibilityState = "visible";
  env.document.dispatch("visibilitychange");
  assert.equal(env.intervals.size, 0);
  assert.equal(env.rafs.size, 1);
  stream.getVideoTracks()[0].stop();
  assert.equal(env.rafs.size + env.intervals.size, 0);
});

test("disabling while vanished targets the live image", async () => {
  const env = setup();
  await env.devices.getUserMedia({ video: true });
  env.api.state.hasBackground = true;
  env.api.state.backgroundData = "data:image/jpeg;base64,TEST";
  env.api.state.backgroundImage = {};
  env.api.setVanished(true);
  env.configure({ enabled: false, background: env.api.state.backgroundData });
  assert.equal(env.api.state.vanished, false);
  assert.equal([...env.api.state.pipelines][0].transition.to, 0);
});

test("snap detection cannot start before room capture", async () => {
  const env = setup();
  env.api.toggleSnap(true);
  assert.equal(env.api.state.snapEnabled, false);
  assert.equal(env.requests.length, 0);
});

test("cancelling pending mic permission releases the later result", async () => {
  const env = setup({ pendingMic: true });
  env.api.state.hasBackground = true;
  env.api.toggleSnap(true);
  env.api.toggleSnap(false);
  env.resolveMic();
  await flush();
  assert.equal(env.mic.readyState, "ended");
  assert.equal(env.audioContexts.length, 0);
  assert.equal(env.intervals.size, 0);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].audio.noiseSuppression, false);
});

test("snap analyser owns only a clone of Meet audio and cleans it up", async () => {
  const env = setup();
  env.api.state.hasBackground = true;
  env.api.state.lastAudioTrack = env.rawAudio;
  env.api.toggleSnap(true);
  await flush();
  const audioContext = env.audioContexts[0];
  assert.notEqual(audioContext.input, env.rawAudio);
  env.api.toggleSnap(false);
  assert.equal(audioContext.input.readyState, "ended");
  assert.equal(audioContext.state, "closed");
  assert.equal(env.rawAudio.readyState, "live");
  assert.equal(env.intervals.size, 0);
});

test("partial AudioContext setup failure closes context and clone", async () => {
  const env = setup({ sourceFails: true });
  env.api.state.hasBackground = true;
  env.api.state.lastAudioTrack = env.rawAudio;
  env.api.toggleSnap(true);
  await flush();
  assert.equal(env.audioContexts[0].state, "closed");
  assert.equal(env.audioContexts[0].input.readyState, "ended");
  assert.equal(env.rawAudio.readyState, "live");
  assert.equal(env.api.state.snapEnabled, false);
});

async function detector() {
  const env = setup();
  env.api.state.hasBackground = true;
  env.api.state.lastAudioTrack = env.rawAudio;
  env.api.toggleSnap(true);
  await flush();
  for (let i = 0; i < 40; i++) env.tick(0.003);
  return env;
}

test("short high-energy transient toggles once and respects debounce", async () => {
  const env = await detector();
  env.tick(0.09);
  env.tick(0.005);
  assert.equal(env.api.state.vanished, true);
  env.tick(0.09);
  env.tick(0.005);
  assert.equal(env.api.state.vanished, true);
  for (let i = 0; i < 60; i++) env.tick(0.003);
  env.tick(0.09);
  env.tick(0.005);
  assert.equal(env.api.state.vanished, false);
});

test("sustained burst tail and low-level key-like transients do not toggle", async () => {
  const env = await detector();
  for (let i = 0; i < 15; i++) env.tick(0.09);
  env.tick(0.005);
  assert.equal(env.api.state.vanished, false);
  for (let i = 0; i < 60; i++) env.tick(0.003);
  for (let i = 0; i < 5; i++) {
    env.tick(0.011);
    env.tick(0.003);
  }
  assert.equal(env.api.state.vanished, false);
});

test("detector track loss unchecks snap state and closes resources", async () => {
  const env = await detector();
  env.audioContexts[0].input.stop();
  env.tick(0.003);
  assert.equal(env.api.state.snapEnabled, false);
  assert.equal(env.audioContexts[0].state, "closed");
  assert.equal(env.intervals.size, 0);
});

test("pagehide releases camera outputs and detector resources", async () => {
  const env = setup();
  const stream = await env.devices.getUserMedia({ video: true, audio: true });
  env.api.state.hasBackground = true;
  env.api.toggleSnap(true);
  await flush();
  env.window.dispatch("pagehide");
  assert.equal(env.rawVideo.readyState, "ended");
  assert.equal(stream.getVideoTracks()[0].readyState, "ended");
  assert.equal(env.intervals.size + env.rafs.size, 0);
  assert.equal(env.audioContexts[0].state, "closed");
});

test("V-sign samples use raw camera while vanished and can make the user appear", async () => {
  const env = setup();
  await env.devices.getUserMedia({ video: true });
  env.api.state.hasBackground = true;
  env.api.state.backgroundImage = {};
  env.api.setVanished(true);
  env.api.toggleGesture(true);
  const video = [...env.api.state.pipelines][0].video;
  env.drawSources.length = 0;
  for (let i = 0; i < 7; i++) {
    env.tick(0.003, 150);
    const pending = env.api.state.gesturePending;
    assert.ok(pending);
    env.api.handleGestureResult({ ...pending, ok: true, isV: true, handPresent: true });
  }
  assert.equal(env.api.state.vanished, false);
  assert.ok(env.drawSources.every((source) => source === video));
  assert.equal(env.requests.length, 1); // No extra camera or microphone request.
  for (let i = 0; i < 25; i++) {
    env.tick(0.003, 150);
    env.api.handleGestureResult({
      ...env.api.state.gesturePending, ok: true, isV: true, handPresent: true
    });
  }
  assert.equal(env.api.state.vanished, false); // A held hand never repeats.
  env.api.toggleGesture(false);
  assert.equal(env.api.state.gestureTimer, 0);
});

test("stale V result is ignored after detection is disabled", async () => {
  const env = setup();
  await env.devices.getUserMedia({ video: true });
  env.api.state.hasBackground = true;
  env.api.toggleGesture(true);
  env.api.sampleGestureFrame();
  const pending = { ...env.api.state.gesturePending };
  env.api.toggleGesture(false);
  env.api.handleGestureResult({ ...pending, ok: true, isV: true, handPresent: true });
  assert.equal(env.api.state.vanished, false);
  assert.equal(env.api.state.gesturePending, null);
});

test("V frame sampling pauses in hidden tabs", async () => {
  const env = setup();
  await env.devices.getUserMedia({ video: true });
  env.api.state.hasBackground = true;
  env.api.toggleGesture(true);
  env.postedMessages.length = 0;
  env.document.visibilityState = "hidden";
  env.api.sampleGestureFrame();
  assert.ok(!env.postedMessages.some((message) => message.action === "GESTURE_FRAME"));
  assert.equal(env.api.state.gesturePending, null);
});

async function dustEnvironment(options = {}) {
  const env = setup({ dust: true, ...options });
  await env.devices.getUserMedia({video:true,audio:true});
  env.api.state.hasBackground = true;
  env.api.state.backgroundImage = {};
  env.api.state.thanos = true;
  return env;
}

test("Thanos starts immediately without waiting for a mask and reappears with reversed phases", async () => {
  const env = await dustEnvironment();
  const pipeline = [...env.api.state.pipelines][0];
  env.api.setVanished(true);
  assert.equal(pipeline.dustPreparing, false);
  assert.equal(pipeline.transition.particles, true); // Starts before model reply.
  env.respondPerson();
  await flush();
  assert.equal(pipeline.transition.particles, true);
  assert.ok(pipeline.personMaskCache);
  assert.equal(env.dustEffects[0].args.video, pipeline.video,
    "the animation must receive live raw video, never a captured still");
  env.frame();
  assert.ok(env.dustEffects[0].phases.at(-1) < .02);
  env.tick(0.003, 2300); env.frame();
  assert.equal(pipeline.bgAlpha, 1);
  env.api.setVanished(false);
  env.respondPerson(); await flush();
  assert.equal(pipeline.transition.particles, true);
  assert.equal(pipeline.transition.dustFrom, 1);
  assert.equal(pipeline.transition.dustTo, 0);
  env.frame();
  assert.ok(env.dustEffects[1].phases.at(-1) > .98);
  env.tick(0.003, 2300); env.frame();
  assert.equal(env.dustEffects[1].phases.at(-1), 0);
  assert.equal(pipeline.bgAlpha, 0);
  assert.equal(env.requests.length, 1); // Same raw camera, no extra media permissions.
});

test("reversing active dust reuses its silhouette/cloud without a fade or second mask", async () => {
  const env = await dustEnvironment();
  env.api.setVanished(true);
  env.respondPerson(); await flush();
  env.tick(.003, 600); env.frame();
  const effect = env.dustEffects[0];
  const previous = effect.phases.at(-1);
  env.api.setVanished(false);
  env.frame();
  assert.equal(env.dustEffects.length, 1);
  assert.equal(effect.disposed, false);
  assert.ok(effect.phases.at(-1) < previous);
  assert.equal(env.postedMessages.filter((message) => message.action === "PERSON_FRAME").length, 2);
});

test("dust draw cadence is bounded to the outgoing 30-fps track, without delaying reversals", async () => {
  const env=await dustEnvironment();
  env.api.setVanished(true);
  env.respondPerson(); await flush();
  const effect=env.dustEffects[0];
  const before=effect.phases.length;
  for(let i=0;i<30;i++) env.frame(); // Mock display ticks are 16 ms.
  const draws=effect.phases.length-before;
  assert.ok(draws>=9 && draws<=16, "do not render 30 dust frames for 30 display refreshes");
  const previous=effect.phases.at(-1);
  env.api.setVanished(false); env.frame();
  assert.ok(effect.phases.at(-1)<previous,"reversal bypasses the cadence gate immediately");
});

test("cancelling or stopping during person-mask loading rejects late results", async () => {
  const env = await dustEnvironment();
  env.api.setVanished(true);
  const id = env.postedMessages.at(-1).payload.requestId;
  env.api.setVanished(false);
  env.respondPerson(id); await flush();
  assert.equal(env.dustEffects.length, 1);
  assert.equal(env.api.state.dustRequests.size, 0);
  env.api.setVanished(true);
  await flush(); env.frame();
  const second = env.postedMessages.filter((message) => message.action === "PERSON_FRAME").at(-1).payload.requestId;
  [...env.api.state.pipelines][0].outputTrack.stop();
  env.respondPerson(second); await flush();
  assert.equal(env.dustEffects.length, 1);
  assert.equal(env.dustEffects[0].disposed, true);
  assert.equal(env.api.state.dustRequests.size, 0);
  assert.equal(env.rawAudio.readyState, "live");
});

test("disabling during pending reappearance cancels its mask and restores live video", async () => {
  const env = await dustEnvironment();
  const pipeline = [...env.api.state.pipelines][0];
  pipeline.bgAlpha = 1;
  env.api.state.vanished = true;
  env.api.setVanished(false);
  env.configure({enabled:false,thanos:true});
  await flush();
  assert.equal(env.api.state.dustRequests.size, 0);
  assert.equal(pipeline.transition.to, 0);
  assert.equal(pipeline.transition.particles, false);
});

test("live dust refreshes raw-camera masks with backpressure and rejects late refreshes on reversal", async () => {
  const env = await dustEnvironment({liveDust:true});
  env.api.setVanished(true); env.respondPerson(); await flush();
  const effect = env.dustEffects[0];
  env.tick(.003, 200); env.frame();
  const first = env.postedMessages.filter((message) => message.action === "PERSON_FRAME");
  assert.equal(first.length, 2);
  env.tick(.003, 200); env.frame();
  assert.equal(env.postedMessages.filter((message) => message.action === "PERSON_FRAME").length, 2);
  env.respondPerson(); await flush();
  assert.equal(effect.updates.length, 2);
  env.tick(.003, 200); env.frame();
  const pendingId = env.postedMessages.filter((message) => message.action === "PERSON_FRAME").at(-1).payload.requestId;
  env.api.setVanished(false);
  env.respondPerson(pendingId); await flush();
  assert.equal(effect.updates.length, 2); // Old direction/generation cannot update.
  env.tick(.003, 2400); env.frame(); await flush();
  assert.equal(env.api.state.personOwned, true); // Remains warm while Thanos is enabled.
  assert.equal(env.api.state.dustRequests.size, 0);
});

test("idle Thanos prewarms a bounded mask cache and toggles synchronously from it", async () => {
  const env = await dustEnvironment({liveDust:true});
  const pipeline = [...env.api.state.pipelines][0];
  env.frame();
  env.respondPerson(); await flush();
  assert.ok(pipeline.personMaskCache);
  env.api.setVanished(true);
  assert.equal(pipeline.transition.particles, true);
  assert.equal(env.dustEffects[0].args.personMask, pipeline.personMaskCache);
  pipeline.outputTrack.stop(); await flush();
  assert.equal(env.api.state.personOwned, false);
  assert.equal(env.api.state.dustRequests.size, 0);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
      passed++;
    } catch (error) {
      console.error(`FAIL ${name}\n${error.stack}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed.`);
})();