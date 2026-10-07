"use strict";

(() => {
  const DEBUG = false;
  const MESSAGE_TYPE = "MEET_VANISH_BRIDGE_V1";
  const MAX_IMAGE_LENGTH = 7_500_000;
  const SENSITIVITY = { low: 8, medium: 6, high: 4 };
  let nativeGetUserMedia = null;
  let snapGeneration = 0;
  let backgroundGeneration = 0;
  let pendingBackgroundData = "";
  const state = {
    enabled: true,
    backgroundData: "",
    backgroundImage: null,
    hasBackground: false,
    panelPosition: null,
    sensitivity: "medium",
    thanos: false,
    gestureEnabled: false,
    gestureTimer: 0,
    gesturePending: null,
    gestureGeneration: 0,
    gestureRequestId: 0,
    gestureGate: null,
    gestureCanvas: null,
    gestureStatus: "Off",
    dustRequestId: 0,
    dustRequests: new Map(),
    personOwned: false,
    vanished: false,
    snapEnabled: false,
    snapStarting: false,
    snapCleanup: null,
    lastAudioTrack: null,
    pipelines: new Set(),
    panel: null,
    collapsed: false,
    captureTimer: null,
    captureCountdown: 0,
    captureRawVideo: null
  };

  const log = (...args) => {
    if (DEBUG) console.debug("[Meet Vanish]", ...args);
  };
  const sendBridge = (action, payload = {}) => {
    window.postMessage({ type: MESSAGE_TYPE, action, payload }, location.origin);
  };

  function installCameraWrapper() {
    const devices = navigator.mediaDevices;
    if (!devices || typeof devices.getUserMedia !== "function") return;
    nativeGetUserMedia = devices.getUserMedia.bind(devices);
    try {
      Object.defineProperty(devices, "getUserMedia", {
        configurable: true,
        writable: true,
        value: function (constraints) {
          return nativeGetUserMedia(constraints).then(async (stream) => {
            const videoTracks = stream.getVideoTracks();
            rememberMeetAudio(stream);
            if (!state.enabled || !constraints?.video || videoTracks.length === 0) {
              return stream;
            }

            try {
              return await createCompositeStream(stream, videoTracks[0]);
            } catch (error) {
              console.warn("[Meet Vanish] Camera compositing failed; using the original stream.", error);
              return stream;
            }
          });
        }
      });
      log("getUserMedia wrapper installed at document_start");
    } catch (error) {
      console.warn("[Meet Vanish] Could not wrap getUserMedia; camera will remain unchanged.", error);
    }
  }

  function rememberMeetAudio(stream) {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack || audioTrack === state.lastAudioTrack) return;
    state.lastAudioTrack = audioTrack;
    if (state.enabled && state.snapEnabled) {
      stopSnapDetection();
      startSnapDetection();
    }
  }

  function getCanvasSize(track) {
    const settings = track.getSettings ? track.getSettings() : {};
    let width = Math.round(settings.width || 1280);
    let height = Math.round(settings.height || 720);
    if (!width || !height) {
      width = 1280;
      height = 720;
    }
    const scale = Math.min(1, 1920 / width, 1080 / height);
    return {
      width: Math.max(2, Math.round(width * scale)),
      height: Math.max(2, Math.round(height * scale))
    };
  }

  function waitForVideoFrame(video, rawTrack) {
    return new Promise((resolve, reject) => {
      let timeout;
      let settled = false;
      let playing = false;
      const events = ["loadeddata", "canplay", "playing"];
      const finish = (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        for (const name of events) video.removeEventListener(name, check);
        video.removeEventListener("error", failed);
        rawTrack.removeEventListener("ended", failed);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (playing && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            video.videoWidth > 0 && video.videoHeight > 0) finish();
      };
      const failed = () => finish(new Error("Camera source did not produce a frame."));
      for (const name of events) video.addEventListener(name, check);
      video.addEventListener("error", failed);
      rawTrack.addEventListener("ended", failed);
      timeout = window.setTimeout(failed, 2500);
      try {
        Promise.resolve(video.play()).then(() => {
          playing = true;
          check();
        }, (error) => finish(error));
      } catch (error) {
        finish(error);
      }
      check();
    });
  }

  async function createCompositeStream(rawStream, rawTrack) {
    const dimensions = getCanvasSize(rawTrack);
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!context || typeof canvas.captureStream !== "function") {
      throw new Error("Canvas capture is not supported in this browser.");
    }

    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([rawTrack]);
    video.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:2px;height:2px;opacity:0;pointer-events:none";
    let canvasStream = null;
    let pipeline = null;
    try {
      if (document.documentElement) document.documentElement.appendChild(video);
      await waitForVideoFrame(video, rawTrack);
      if (!state.enabled) {
        video.pause();
        video.srcObject = null;
        video.remove();
        return rawStream;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvasStream = canvas.captureStream(30);
      const replacementTracks = canvasStream.getVideoTracks();
      if (!replacementTracks.length) throw new Error("Canvas did not create a video track.");
      const outputTrack = replacementTracks[0];
      const outputStream = new MediaStream([
        outputTrack,
        ...rawStream.getAudioTracks()
      ]);

      pipeline = {
        canvas,
        context,
        video,
        rawStream,
        rawTrack,
        outputTrack,
        outputTracks: new Map(),
        canvasStream,
        timer: 0,
        raf: 0,
        visibilityHandler: null,
        transition: null,
        bgAlpha: state.vanished ? 1 : 0,
        dustEffect: null,
        dustGeneration: 0,
        dustPreparing: false,
        personMaskPending: false,
        personMaskSampleAt: -Infinity,
        personMaskCache: null,
        cleaned: false,
        draw: null
      };
      state.pipelines.add(pipeline);
      syncGestureDetection();
      guardOutputTrack(pipeline, outputTrack);
      guardStreamClones(pipeline, outputStream);
      rawTrack.addEventListener("ended", () => cleanupPipeline(pipeline), { once: true });

      pipeline.draw = () => drawPipeline(pipeline);
      let lastAnimationDraw = -Infinity;
      const animate = () => {
        pipeline.raf = 0;
        if (pipeline.cleaned || document.visibilityState === "hidden") return;
        const now = performance.now();
        // The outgoing track is 30 fps. Do not run expensive dust passes at
        // the display's 60/120 Hz rate just to encode duplicate camera frames.
        if (pipeline.forceDraw || now - lastAnimationDraw >= 1000 / 30 - 1 || allOutputTracksEnded(pipeline)) {
          pipeline.forceDraw = false;
          lastAnimationDraw = now;
          pipeline.draw();
        }
        if (!pipeline.cleaned) pipeline.raf = window.requestAnimationFrame(animate);
      };
      pipeline.visibilityHandler = () => {
        if (pipeline.cleaned) return;
        if (document.visibilityState === "hidden") {
          window.cancelAnimationFrame(pipeline.raf);
          pipeline.raf = 0;
          if (!pipeline.timer) pipeline.timer = window.setInterval(pipeline.draw, 33);
        } else {
          window.clearInterval(pipeline.timer);
          pipeline.timer = 0;
          if (!pipeline.raf) pipeline.raf = window.requestAnimationFrame(animate);
        }
      };
      document.addEventListener("visibilitychange", pipeline.visibilityHandler);
      pipeline.draw();
      pipeline.visibilityHandler();
      return outputStream;
    } catch (error) {
      if (pipeline) cleanupPipeline(pipeline, false);
      else if (canvasStream) {
        for (const track of canvasStream.getTracks()) {
          try { track.stop(); } catch {}
        }
      }
      // Roll back only our resources. The fallback raw camera/audio remain owned by Meet.
      video.pause();
      video.srcObject = null;
      video.remove();
      throw error;
    }
  }

  function allOutputTracksEnded(pipeline) {
    return [...pipeline.outputTracks.keys()].every((track) => track.readyState === "ended");
  }

  function guardOutputTrack(pipeline, track) {
    if (pipeline.outputTracks.has(track)) return;
    const nativeStop = track.stop.bind(track);
    const nativeClone = track.clone.bind(track);
    pipeline.outputTracks.set(track, nativeStop);
    const checkStopped = () => {
      if (!pipeline.cleaned && allOutputTracksEnded(pipeline)) cleanupPipeline(pipeline);
    };
    track.addEventListener("ended", checkStopped);
    try {
      Object.defineProperty(track, "stop", {
        configurable: true,
        value: () => {
          nativeStop();
          checkStopped();
        }
      });
      Object.defineProperty(track, "clone", {
        configurable: true,
        value: () => {
          const clone = nativeClone();
          guardOutputTrack(pipeline, clone);
          return clone;
        }
      });
    } catch (error) {
      log("Track lifecycle methods could not be wrapped; polling stopped tracks.", error);
    }
  }

  function guardStreamClones(pipeline, stream) {
    const nativeClone = stream.clone.bind(stream);
    try {
      Object.defineProperty(stream, "clone", {
        configurable: true,
        value: () => {
          const clone = nativeClone();
          for (const track of clone.getVideoTracks()) guardOutputTrack(pipeline, track);
          guardStreamClones(pipeline, clone);
          return clone;
        }
      });
    } catch (error) {
      log("Could not track stream clones.", error);
    }
  }

  function cleanupPipeline(pipeline, releaseRaw = true) {
    if (pipeline.cleaned) return;
    pipeline.cleaned = true;
    pipeline.dustGeneration += 1;
    cancelPersonRequests(pipeline);
    pipeline.dustEffect?.dispose();
    pipeline.dustEffect = null;
    pipeline.personMaskCache = null;
    window.clearInterval(pipeline.timer);
    window.cancelAnimationFrame(pipeline.raf);
    if (pipeline.visibilityHandler) {
      document.removeEventListener("visibilitychange", pipeline.visibilityHandler);
    }
    pipeline.video.pause();
    pipeline.video.srcObject = null;
    pipeline.video.remove();
    if (releaseRaw) {
      for (const track of pipeline.rawStream.getVideoTracks()) {
        if (track.readyState !== "ended") {
          try { track.stop(); } catch {}
        }
      }
    }
    for (const [track, nativeStop] of pipeline.outputTracks) {
      if (track.readyState !== "ended") {
        try { nativeStop(); } catch {}
      }
    }
    state.pipelines.delete(pipeline);
    syncPersonOwnership();
    syncGestureDetection();
    if (state.pipelines.size === 0 && state.snapEnabled) {
      state.snapEnabled = false;
      stopSnapDetection();
      updatePanel();
    }
    if (state.captureRawVideo === pipeline.video) state.captureRawVideo = null;
    log("Camera pipeline stopped and raw camera released");
  }

  function cancelPersonRequests(pipeline) {
    pipeline.dustPreparing = false;
    for (const [id, request] of state.dustRequests) {
      if (request.pipeline !== pipeline) continue;
      state.dustRequests.delete(id);
      window.clearTimeout(request.timer);
      request.resolve(null);
    }
  }

  function syncPersonOwnership() {
    const active = state.enabled && [...state.pipelines].some((pipeline) =>
      !pipeline.cleaned && (pipeline.dustEffect || (state.thanos && state.hasBackground)));
    if (active === state.personOwned) return;
    state.personOwned = active;
    sendBridge("PERSON_CONTROL", { enabled: active });
  }

  function handlePersonResult(payload) {
    const request = state.dustRequests.get(payload?.requestId);
    if (!request) return;
    state.dustRequests.delete(payload.requestId);
    window.clearTimeout(request.timer);
    try {
      if (!payload.ok || !Number.isInteger(payload.width) || !Number.isInteger(payload.height) ||
          payload.width < 1 || payload.height < 1 || payload.width > 512 || payload.height > 512 ||
          typeof payload.mask !== "string" || payload.mask.length > 350_000) {
        request.resolve(null);
        return;
      }
      const bytes = Uint8Array.from(atob(payload.mask), (char) => char.charCodeAt(0));
      if (bytes.length !== payload.width * payload.height) throw new Error("Invalid person mask.");
      request.resolve({ width: payload.width, height: payload.height, mask: bytes });
    } catch {
      request.resolve(null);
    }
  }

  async function requestPersonMask(pipeline) {
    const sample = document.createElement("canvas");
    try {
      const scale = Math.min(1, 320 / Math.max(pipeline.canvas.width, pipeline.canvas.height));
      sample.width = Math.max(1, Math.round(pipeline.canvas.width * scale));
      sample.height = Math.max(1, Math.round(pipeline.canvas.height * scale));
      sample.getContext("2d", { alpha: false }).drawImage(
        pipeline.video, 0, 0, sample.width, sample.height);
      const image = sample.toDataURL("image/jpeg", 0.85);
      if (image.length > 250_000) return null;
      return await new Promise((resolve) => {
        const requestId = ++state.dustRequestId;
        const timer = window.setTimeout(() => {
          state.dustRequests.delete(requestId);
          resolve(null);
        }, 15_000);
        state.dustRequests.set(requestId, { pipeline, timer, resolve });
        sendBridge("PERSON_FRAME", { requestId, image });
      });
    } catch (error) {
      log("Person dust preparation failed.", error);
      return null;
    } finally {
      sample.width = sample.height = 1;
    }
  }

  function refreshPersonMask(pipeline, now) {
    if (!state.enabled || !state.thanos || !state.hasBackground || pipeline.personMaskPending ||
        document.visibilityState === "hidden" ||
        now - pipeline.personMaskSampleAt < (pipeline.dustEffect ? 180 : 360)) return;
    pipeline.personMaskSampleAt = now;
    pipeline.personMaskPending = true;
    const generation = pipeline.dustGeneration;
    requestPersonMask(pipeline).then((mask) => {
      if (mask && !pipeline.cleaned && generation === pipeline.dustGeneration) {
        pipeline.personMaskCache = mask;
        pipeline.dustEffect?.updatePersonMask(mask);
      }
    }).catch((error) => log("Person mask refresh failed.", error))
      .finally(() => { pipeline.personMaskPending = false; });
  }

  function startPipelineTransition(pipeline, shouldVanish, dustEffect, dustFrom) {
    pipeline.forceDraw = true; // First/reversed frame must not wait for the 30-fps gate.
    pipeline.lastDustPhase = dustFrom;
    pipeline.dustPreparing = false;
    pipeline.dustEffect = dustEffect;
    if (!pipeline.personMaskCache) pipeline.personMaskSampleAt = -Infinity;
    syncPersonOwnership();
    const dustTo = shouldVanish ? 1 : 0;
    pipeline.transition = {
      from: pipeline.bgAlpha,
      to: shouldVanish ? 1 : 0,
      startedAt: performance.now(),
      duration: dustEffect
        ? Math.max(16, globalThis.MeetVanishDust.duration * Math.abs(dustTo - dustFrom))
        : 400,
      particles: Boolean(dustEffect),
      dustFrom,
      dustTo
    };
  }

  function transitionPipeline(pipeline, shouldVanish, useParticles) {
    if (pipeline.cleaned) return;
    pipeline.dustGeneration += 1;
    cancelPersonRequests(pipeline);
    if (useParticles && pipeline.dustEffect && pipeline.transition?.particles) {
      const previous = pipeline.transition;
      const progress = Math.min(1, (performance.now() - previous.startedAt) / previous.duration);
      const phase = Number.isFinite(pipeline.lastDustPhase) ? pipeline.lastDustPhase :
        previous.dustFrom + (previous.dustTo - previous.dustFrom) * progress;
      // Reuse the same silhouette/cloud when interrupted: reverse from its
      // current phase rather than jumping to a different snapshot or fade.
      startPipelineTransition(pipeline, shouldVanish, pipeline.dustEffect, phase);
      return;
    }
    pipeline.dustEffect?.dispose();
    pipeline.dustEffect = null;
    if (useParticles && state.backgroundImage && globalThis.MeetVanishDust &&
        (shouldVanish ? pipeline.bgAlpha < 0.15 : pipeline.bgAlpha > 0.85)) {
      const effect = globalThis.MeetVanishDust.prepare({
        video:pipeline.video,background:state.backgroundImage,
        width:pipeline.canvas.width,height:pipeline.canvas.height,
        personMask:pipeline.personMaskCache
      });
      if (!effect) {
        startPipelineTransition(pipeline,shouldVanish,null,shouldVanish ? 0 : 1);
        pipeline.transition.duration=16;
        setPanelMessage("GPU grain effect unavailable. Switched without animation.",true,5000);
        return;
      }
      startPipelineTransition(pipeline, shouldVanish, effect, shouldVanish ? 0 : 1);
      refreshPersonMask(pipeline, performance.now());
      setPanelMessage(shouldVanish ? "Dusting out…" : "Re-forming from dust…", false, 2400);
      return;
    }
    startPipelineTransition(pipeline, shouldVanish, null, shouldVanish ? 0 : 1);
  }

  function drawPipeline(pipeline) {
    if (pipeline.cleaned) return;
    // stop() does not emit "ended". This also covers an unwrappable stop method.
    if (allOutputTracksEnded(pipeline)) {
      cleanupPipeline(pipeline);
      return;
    }
    const { context, canvas, video } = pipeline;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        video.videoWidth === 0 || video.videoHeight === 0) return;
    syncPersonOwnership();
    if (!pipeline.dustEffect) refreshPersonMask(pipeline, performance.now());

    const transition = pipeline.transition;
    let progress = 0;
    if (transition) {
      progress = Math.min(1, (performance.now() - transition.startedAt) / transition.duration);
      const eased = progress * progress * (3 - 2 * progress);
      pipeline.bgAlpha = transition.from + (transition.to - transition.from) * eased;
      if (progress >= 1) {
        pipeline.bgAlpha = transition.to;
      }
    }

    try {
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      if (transition?.particles && pipeline.dustEffect) {
        const dustPhase = transition.dustFrom + (transition.dustTo - transition.dustFrom) * progress;
        const now = performance.now();
        pipeline.dustEffect.render(context, dustPhase, now);
        pipeline.lastDustPhase = dustPhase;
        if (progress < 1) refreshPersonMask(pipeline, now);
      } else {
        if (pipeline.bgAlpha < 1 || !state.backgroundImage) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
        }
        if (state.hasBackground && state.backgroundImage && pipeline.bgAlpha > 0) {
          context.globalAlpha = pipeline.bgAlpha;
          context.drawImage(state.backgroundImage, 0, 0, canvas.width, canvas.height);
          context.globalAlpha = 1;
        }
      }
      context.globalAlpha = 1;
    } catch (error) {
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      if (pipeline.dustEffect) {
        pipeline.dustEffect.dispose();
        pipeline.dustEffect = null;
        syncPersonOwnership();
        transition.particles = false;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (state.backgroundImage) {
          context.globalAlpha = pipeline.bgAlpha;
          context.drawImage(state.backgroundImage, 0, 0, canvas.width, canvas.height);
          context.globalAlpha = 1;
        }
      }
      log("Frame draw skipped.", error);
    }
    if (transition && progress >= 1) {
      pipeline.transition = null;
      pipeline.dustEffect?.dispose();
      pipeline.dustEffect = null;
      cancelPersonRequests(pipeline);
      syncPersonOwnership();
    }
  }

  function setVanished(shouldVanish) {
    if (!state.hasBackground) {
      setPanelMessage("Capture your empty room first.", true);
      return;
    }
    if (state.vanished === shouldVanish) return;
    state.vanished = shouldVanish;
    const useDust = state.enabled && state.thanos;
    for (const pipeline of state.pipelines) {
      transitionPipeline(pipeline, shouldVanish, useDust);
    }
    updatePanel();
  }

  function toggleVanished() {
    if (!state.enabled) return;
    setVanished(!state.vanished);
  }

  function syncGestureDetection() {
    const shouldRun = state.enabled && state.gestureEnabled && state.hasBackground &&
      state.pipelines.size > 0 && globalThis.MeetVanishGestureRules;
    if (!shouldRun) {
      if (state.gestureTimer || state.gesturePending) {
        state.gestureGeneration += 1;
        window.clearInterval(state.gestureTimer);
        state.gestureTimer = 0;
        state.gesturePending = null;
        state.gestureGate = null;
        state.gestureCanvas = null;
        sendBridge("GESTURE_CONTROL", { enabled: false });
      }
      state.gestureStatus = state.gestureEnabled ? "Waiting for camera and room capture" : "Off";
      updatePanel();
      return;
    }
    if (state.gestureTimer) return;
    state.gestureGeneration += 1;
    state.gestureGate = globalThis.MeetVanishGestureRules.createHoldGate();
    state.gestureCanvas = document.createElement("canvas");
    state.gestureStatus = "Loading local hand model…";
    state.gestureTimer = window.setInterval(sampleGestureFrame, 150);
    sendBridge("GESTURE_CONTROL", { enabled: true });
    updatePanel();
  }

  function toggleGesture(enabled) {
    state.gestureEnabled = enabled && state.enabled && state.hasBackground;
    syncGestureDetection();
    savePrefs({ gesture: state.gestureEnabled });
  }

  function sampleGestureFrame() {
    if (!state.enabled || !state.gestureEnabled || !state.hasBackground ||
        document.visibilityState === "hidden") return;
    if (state.gesturePending) {
      if (performance.now() - state.gesturePending.startedAt > 15_000) {
        state.gestureEnabled = false;
        syncGestureDetection();
        savePrefs({ gesture: false });
        setPanelMessage("Hand model timed out. Toggle V detection to retry.", true);
      }
      return;
    }
    const pipeline = [...state.pipelines].reverse().find((item) =>
      !item.cleaned && item.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      item.video.videoWidth > 0);
    if (!pipeline) return;
    try {
      const canvas = state.gestureCanvas;
      const scale = Math.min(320 / pipeline.video.videoWidth, 320 / pipeline.video.videoHeight);
      const width = Math.max(1, Math.round(pipeline.video.videoWidth * scale));
      const height = Math.max(1, Math.round(pipeline.video.videoHeight * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      // Always use the RAW video, including while outgoing video is vanished.
      canvas.getContext("2d", { alpha: false }).drawImage(pipeline.video, 0, 0, width, height);
      const image = canvas.toDataURL("image/jpeg", 0.72);
      if (image.length > 250_000) throw new Error("Camera sample too large.");
      state.gesturePending = {
        requestId: ++state.gestureRequestId,
        generation: state.gestureGeneration,
        startedAt: performance.now()
      };
      sendBridge("GESTURE_FRAME", {
        image,
        requestId: state.gesturePending.requestId,
        generation: state.gesturePending.generation
      });
    } catch (error) {
      log("Gesture camera sampling failed.", error);
      state.gestureEnabled = false;
      syncGestureDetection();
      savePrefs({ gesture: false });
      setPanelMessage("Could not sample the camera for hand detection.", true);
    }
  }

  function handleGestureResult(payload) {
    const pending = state.gesturePending;
    if (!pending || !state.gestureEnabled || !payload ||
        payload.requestId !== pending.requestId || payload.generation !== pending.generation ||
        payload.generation !== state.gestureGeneration || typeof payload.ok !== "boolean") return;
    state.gesturePending = null;
    if (!payload.ok) {
      state.gestureEnabled = false;
      syncGestureDetection();
      savePrefs({ gesture: false });
      setPanelMessage("Hand detector unavailable. Reload extension and Meet to retry.", true);
      return;
    }
    if (payload.skipped === true || document.visibilityState === "hidden") return;
    if (typeof payload.isV !== "boolean" || typeof payload.handPresent !== "boolean") return;
    const gate = state.gestureGate.update(payload.isV, performance.now());
    if (gate.triggered) {
      toggleVanished();
      setPanelMessage("V sign detected.", false, 1300);
    }
    state.gestureStatus = gate.latched
      ? "Lower your hand before the next V sign"
      : payload.isV
        ? `Hold V… ${Math.round(gate.progress * 100)}%`
        : payload.handPresent ? "Ready — hold a V sign" : "Show your hand, then hold a V sign";
    updatePanel();
  }

  function toggleSnap(enabled) {
    if (enabled && (!state.enabled || !state.hasBackground)) return;
    state.snapEnabled = enabled;
    if (!enabled) {
      stopSnapDetection();
      updatePanel();
      return;
    }
    startSnapDetection();
  }

  function stopSnapDetection() {
    snapGeneration += 1;
    if (state.snapCleanup) state.snapCleanup();
    state.snapCleanup = null;
    state.snapStarting = false;
    updateMeter(0, false);
  }

  async function startSnapDetection() {
    if (!state.enabled || !state.snapEnabled || state.snapStarting || state.snapCleanup) return;
    const generation = ++snapGeneration;
    state.snapStarting = true;
    updatePanel();
    let inputTrack = null;
    let audioContext = null;
    let source = null;
    let highpass = null;
    let analyser = null;
    let interval = 0;
    const ownedTracks = [];
    const stillActive = () => generation === snapGeneration && state.enabled && state.snapEnabled;
    // This closure remains safe if a pending permission prompt resolves after cancellation.
    const releaseResources = () => {
      window.clearInterval(interval);
      try { source?.disconnect(); highpass?.disconnect(); analyser?.disconnect(); } catch {}
      if (audioContext && audioContext.state !== "closed") {
        audioContext.close().catch(() => {});
      }
      for (const track of ownedTracks) {
        try { track.stop(); } catch {}
      }
    };
    state.snapCleanup = releaseResources;
    try {
      const meetTrack = state.lastAudioTrack;
      if (meetTrack?.readyState === "live" && meetTrack.enabled && !meetTrack.muted) {
        try {
          inputTrack = meetTrack.clone();
          ownedTracks.push(inputTrack);
        } catch (error) {
          log("Meet audio clone unavailable; trying a separate mic.", error);
        }
      }
      if (!inputTrack) {
        if (!nativeGetUserMedia) throw new Error("getUserMedia is unavailable.");
        // Bypass our wrapper: this microphone belongs to the detector, not Meet.
        const micStream = await nativeGetUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          },
          video: false
        });
        ownedTracks.push(...micStream.getTracks());
        inputTrack = micStream.getAudioTracks()[0];
        if (!inputTrack) throw new Error("No microphone track was returned.");
      }
      if (!stillActive()) {
        releaseResources();
        return;
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Web Audio is unavailable.");
      audioContext = new AudioContextClass();
      source = audioContext.createMediaStreamSource(new MediaStream([inputTrack]));
      highpass = audioContext.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 2000;
      highpass.Q.value = 0.7;
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(highpass);
      highpass.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const history = [];
      let candidate = null;
      let armed = true;
      let previousRms = 0;
      let lastTrigger = -Infinity;
      let lastMeterPost = 0;
      const calibrationUntil = performance.now() + 650;
      await audioContext.resume();
      if (!stillActive()) {
        releaseResources();
        return;
      }

      interval = window.setInterval(() => {
        if (!stillActive()) return;
        if (inputTrack.readyState !== "live") {
          state.snapEnabled = false;
          stopSnapDetection();
          setPanelMessage("Snap microphone stopped. Turn detection on to retry.", true);
          updatePanel();
          return;
        }
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        const now = performance.now();
        const recent = history.length ? history.reduce((total, value) => total + value, 0) / history.length : 0.003;
        const baseline = Math.max(0.003, recent);
        const peakFloor = { low: 0.035, medium: 0.025, high: 0.018 }[state.sensitivity] || 0.025;
        const threshold = Math.max(peakFloor * 0.72, baseline * (SENSITIVITY[state.sensitivity] || 6));

        if (!armed && rms < threshold * 0.45) armed = true;
        if (now >= calibrationUntil && armed && !candidate && rms > threshold &&
            previousRms < threshold * 0.7 && now - lastTrigger >= 1000) {
          candidate = { startedAt: now, peak: rms, baseline };
        } else if (candidate) {
          candidate.peak = Math.max(candidate.peak, rms);
          const age = now - candidate.startedAt;
          if (age <= 115 && rms < candidate.peak * 0.42) {
            const strongEnough = candidate.peak > Math.max(peakFloor, candidate.baseline * 5);
            if (strongEnough && now - lastTrigger >= 1000) {
              lastTrigger = now;
              toggleVanished();
              setPanelMessage("Snap detected.", false, 650);
              flashMeter();
            }
            candidate = null;
          } else if (age > 115) {
            candidate = null;
            armed = false;
          }
        }
        history.push(now < calibrationUntil ? rms : Math.min(rms, baseline * 2));
        if (history.length > 50) history.shift();
        previousRms = rms;
        if (now - lastMeterPost > 45) {
          lastMeterPost = now;
          updateMeter(Math.min(1, rms * 11), false);
        }
      }, 20);
      state.snapStarting = false;
      updatePanel();
      log("Snap detection started");
    } catch (error) {
      releaseResources();
      if (generation === snapGeneration) {
        state.snapCleanup = null;
        state.snapStarting = false;
        state.snapEnabled = false;
        setPanelMessage("Microphone unavailable. Check access and try again.", true);
        updatePanel();
      }
      log("Snap detector setup failed.", error);
    }
  }

  function loadBackground(dataUrl) {
    if (dataUrl === pendingBackgroundData && state.hasBackground) return;
    const generation = ++backgroundGeneration;
    pendingBackgroundData = dataUrl;
    if (typeof dataUrl !== "string" ||
        !dataUrl.startsWith("data:image/jpeg;base64,") ||
        dataUrl.length > MAX_IMAGE_LENGTH) {
      state.backgroundData = "";
      if (typeof state.backgroundImage?.close === "function") state.backgroundImage.close();
      state.backgroundImage = null;
      state.hasBackground = false;
      state.vanished = false;
      for (const pipeline of state.pipelines) transitionPipeline(pipeline, false, false);
      if (state.snapEnabled) toggleSnap(false);
      syncGestureDetection();
      updatePanel();
      return;
    }
    const image = new Image();
    image.onload = async () => {
      let decoded;
      try {
        decoded = typeof createImageBitmap === "function"
          ? await createImageBitmap(image)
          : image;
      } catch {
        decoded = image;
      }
      if (generation !== backgroundGeneration) {
        if (typeof decoded?.close === "function") decoded.close();
        return;
      }
      const previous = state.backgroundImage;
      for (const pipeline of state.pipelines) {
        if (pipeline.dustEffect || pipeline.dustPreparing) transitionPipeline(pipeline, state.vanished, false);
      }
      state.backgroundImage = decoded;
      state.backgroundData = dataUrl;
      if (previous && typeof previous.close === "function") previous.close();
      state.hasBackground = true;
      syncGestureDetection();
      updatePanel();
      log("Saved room image loaded");
    };
    image.onerror = () => {
      if (generation !== backgroundGeneration) return;
      state.backgroundData = "";
      if (typeof state.backgroundImage?.close === "function") state.backgroundImage.close();
      state.backgroundImage = null;
      state.hasBackground = false;
      state.vanished = false;
      for (const pipeline of state.pipelines) transitionPipeline(pipeline, false, false);
      if (state.snapEnabled) toggleSnap(false);
      syncGestureDetection();
      updatePanel();
    };
    image.src = dataUrl;
  }

  function handleBridgeMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.type !== MESSAGE_TYPE || typeof message.action !== "string") return;

    if (message.action === "PERSON_RESULT") {
      handlePersonResult(message.payload);
      return;
    }
    if (message.action === "GESTURE_RESULT") {
      handleGestureResult(message.payload);
      return;
    }
    if (message.action === "CONFIG") {
      const payload = message.payload;
      if (!payload || typeof payload !== "object") return;
      state.enabled = payload.enabled !== false;
      state.panelPosition = payload.panelPosition &&
        Number.isFinite(payload.panelPosition.left) &&
        Number.isFinite(payload.panelPosition.top)
        ? { left: payload.panelPosition.left, top: payload.panelPosition.top }
        : null;
      state.sensitivity = ["low", "medium", "high"].includes(payload.sensitivity)
        ? payload.sensitivity
        : "medium";
      state.thanos = payload.thanos === true;
      state.gestureEnabled = payload.gesture === true && state.enabled;
      if (typeof payload.background === "string") loadBackground(payload.background);
      if (!state.enabled) {
        state.vanished = false;
        for (const pipeline of state.pipelines) {
          transitionPipeline(pipeline, false, false);
        }
        state.snapEnabled = false;
        stopSnapDetection();
      }
      ensurePanel();
      syncGestureDetection();
      updatePanel();
      return;
    }

    if (message.action === "COMMAND_TOGGLE") toggleVanished();
  }
  window.addEventListener("message", handleBridgeMessage);

  function savePrefs(values) {
    sendBridge("SAVE_PREFS", values);
  }

  function startCaptureCountdown() {
    if (!state.enabled || state.captureTimer) return;
    state.captureCountdown = 3;
    updatePanel();
    state.captureTimer = window.setInterval(() => {
      state.captureCountdown -= 1;
      if (state.captureCountdown > 0) {
        updatePanel();
        return;
      }
      window.clearInterval(state.captureTimer);
      state.captureTimer = null;
      captureEmptyRoom();
    }, 1000);
  }

  function captureEmptyRoom() {
    const pipeline = [...state.pipelines].reverse().find((item) =>
      !item.cleaned && item.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
    if (!pipeline || !pipeline.video.videoWidth) {
      setPanelMessage("Camera frame not ready. Try again in a moment.", true);
      updatePanel();
      return;
    }

    try {
      const output = document.createElement("canvas");
      const size = getCanvasSize(pipeline.rawTrack);
      output.width = size.width;
      output.height = size.height;
      const ctx = output.getContext("2d");
      ctx.drawImage(pipeline.video, 0, 0, output.width, output.height);
      const dataUrl = output.toDataURL("image/jpeg", 0.82);
      if (dataUrl.length > MAX_IMAGE_LENGTH) {
        setPanelMessage("Image too large to save. Try a lower camera resolution.", true);
        return;
      }
      loadBackground(dataUrl);
      sendBridge("SAVE_BACKGROUND", { image: dataUrl });
      setPanelMessage("Empty room captured.", false, 1600);
    } catch (error) {
      console.warn("[Meet Vanish] Could not capture a camera frame.", error);
      setPanelMessage("Could not capture a frame. Check camera access.", true);
    }
    updatePanel();
  }

  let messageTimer = 0;
  function setPanelMessage(message, isError = false, duration = 0) {
    if (!state.panel) return;
    const root = state.panel.shadowRoot;
    const target = root?.querySelector("#message");
    if (!target) return;
    target.textContent = message;
    target.classList.toggle("error", Boolean(isError));
    window.clearTimeout(messageTimer);
    if (duration) {
      messageTimer = window.setTimeout(() => {
        target.textContent = "";
        target.classList.remove("error");
      }, duration);
    }
  }

  function updateMeter(level, flash) {
    if (!state.panel) return;
    const root = state.panel.shadowRoot;
    const fill = root?.querySelector("#meter-fill");
    const value = root?.querySelector("#meter");
    if (!fill || !value) return;
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, level)) * 100)}%`;
    value.classList.toggle("flash", Boolean(flash));
  }

  function flashMeter() {
    updateMeter(1, true);
    window.setTimeout(() => updateMeter(0.08, false), 220);
  }

  function ensurePanel() {
    if (state.panel || !document.documentElement) return;
    const host = document.createElement("div");
    host.id = "meet-vanish-panel-root";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:20px;bottom:20px";
    const shadow = host.attachShadow({ mode: "open" });
    // Build nodes directly: Meet can enforce Trusted Types on HTML string sinks.
    const style = document.createElement("style");
    style.textContent = `
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel {
          width: min(286px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
          overflow-y: auto; padding: 13px; color: #f4f5fa;
          background: rgba(20, 22, 30, .94); border: 1px solid rgba(255,255,255,.12);
          border-radius: 14px; box-shadow: 0 12px 38px rgba(0,0,0,.32);
          backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
          font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .top { display:flex; align-items:center; justify-content:space-between; margin:0 0 11px; cursor:move; user-select:none; }
        .brand { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; letter-spacing:.01em; }
        .mark { display:grid; place-items:center; width:23px; height:23px; border-radius:8px; background:#6659db; color:white; font-size:14px; }
        button, select { font:inherit; }
        button {
          border:1px solid rgba(255,255,255,.12); border-radius:8px; color:#f7f7fb;
          background:#292c37; cursor:pointer; transition:background .15s ease, transform .15s ease;
        }
        button:hover { background:#353946; }
        button:active { transform:scale(.985); }
        button:disabled { cursor:not-allowed; opacity:.48; }
        .collapse { width:25px; height:25px; padding:0; color:#c4c6d0; background:transparent; border:0; font-size:17px; }
        .capture { width:100%; padding:9px 10px; text-align:center; background:#282635; border-color:#413a5e; }
        .primary { width:100%; margin-top:9px; padding:10px; background:#6659db; border-color:#786df1; font-weight:700; }
        .primary:hover { background:#7568eb; }
        .row { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:11px; }
        .status { display:flex; align-items:center; gap:6px; color:#c3c6d1; }
        .dot { width:7px; height:7px; border-radius:50%; background:#53cf9c; box-shadow:0 0 8px rgba(83,207,156,.45); }
        .dot.vanished { background:#8f83ff; box-shadow:0 0 8px rgba(143,131,255,.55); }
        .thumb-wrap { display:flex; align-items:center; gap:8px; margin-top:9px; min-height:42px; }
        .thumb { width:62px; height:38px; object-fit:cover; background:#0d0f15; border:1px solid rgba(255,255,255,.13); border-radius:6px; }
        .retake { padding:6px 8px; font-size:10px; }
        .hint { color:#9298a9; font-size:10px; }
        .message { min-height:14px; margin-top:7px; color:#aeb4c4; font-size:10px; }
        .message.error { color:#ffaaa3; }
        .setting { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:10px; color:#c7cad4; }
        .setting-label { display:flex; align-items:center; gap:7px; }
        input[type="checkbox"] { accent-color:#786df1; }
        select { padding:4px 19px 4px 7px; color:#f0f1f6; border:1px solid #3b3f4b; border-radius:6px; background:#252832; font-size:10px; }
        .meter { height:5px; flex:1; overflow:hidden; background:#343743; border-radius:99px; }
        .meter-fill { height:100%; width:8%; background:#6cdbab; border-radius:99px; transition:width .07s linear, background .07s linear; }
        .meter.flash .meter-fill { background:#c3a6ff; box-shadow:0 0 9px #b7a1ff; }
        .collapsed { width:44px; height:44px; padding:0; border:1px solid rgba(255,255,255,.18); border-radius:50%; color:white; background:#6659db; box-shadow:0 8px 25px rgba(0,0,0,.3); font-size:20px; }
        .hidden { display:none !important; }
        .disabled { opacity:.72; }
    `;
    const node = (tag, attributes = {}, ...children) => {
      const result = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, value);
      for (const child of children) {
        result.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      }
      return result;
    };
    shadow.appendChild(style);
    shadow.appendChild(node("div", { id: "full", class: "panel" },
      node("div", { id: "drag-handle", class: "top" },
        node("div", { class: "brand" },
          node("span", { class: "mark" }, "◌"),
          node("span", {}, "Meet Vanish")),
        node("button", { id: "collapse", class: "collapse", type: "button", "aria-label": "Collapse panel" }, "−")),
      node("button", { id: "capture", class: "capture", type: "button" }, "Capture empty room"),
      node("div", { class: "thumb-wrap" },
        node("img", { id: "thumbnail", class: "thumb hidden", alt: "Captured empty room" }),
        node("span", { id: "empty-hint", class: "hint" }, "Capture your empty room first."),
        node("button", { id: "retake", class: "retake hidden", type: "button" }, "Retake")),
      node("div", { class: "row" },
        node("span", { class: "status" },
          node("i", { id: "status-dot", class: "dot" }),
          node("span", { id: "status-label" }, "Visible")),
        node("span", { id: "extension-state", class: "hint" })),
      node("button", { id: "toggle", class: "primary", type: "button" }, "Vanish"),
      node("div", { class: "setting" },
        node("label", { class: "setting-label", for: "snap" }, "Snap detection"),
        node("input", { id: "snap", type: "checkbox", "aria-label": "Enable snap detection" })),
      node("div", { class: "setting" },
        node("span", { class: "setting-label" }, "Sensitivity"),
        node("select", { id: "sensitivity", "aria-label": "Snap sensitivity" },
          node("option", { value: "low" }, "Low"),
          node("option", { value: "medium" }, "Medium"),
          node("option", { value: "high" }, "High"))),
      node("div", { class: "setting" },
        node("span", { class: "setting-label" }, "Mic level"),
        node("div", { id: "meter", class: "meter" },
          node("div", { id: "meter-fill", class: "meter-fill" }))),
      node("div", { class: "setting" },
        node("label", { class: "setting-label", for: "thanos" }, "Thanos dust"),
        node("input", { id: "thanos", type: "checkbox", "aria-label": "Enable Thanos dust effect" })),
      node("div", { class: "setting" },
        node("label", { class: "setting-label", for: "gesture" }, "V-sign detection"),
        node("input", { id: "gesture", type: "checkbox", "aria-label": "Enable V-sign detection" })),
      node("div", { id: "gesture-status", class: "hint" }, "Off"),
      node("div", { id: "message", class: "message", role: "status" })));
    shadow.appendChild(node("button", {
      id: "expand", class: "collapsed hidden", type: "button",
      "aria-label": "Expand Meet Vanish panel"
    }, "◌"));
    (document.body || document.documentElement).appendChild(host);
    state.panel = host;
    bindPanelEvents(shadow, host);
    if (state.panelPosition) applyPosition(host, state.panelPosition);
    updatePanel();
  }

  function bindPanelEvents(root, host) {
    root.querySelector("#capture").addEventListener("click", startCaptureCountdown);
    root.querySelector("#retake").addEventListener("click", startCaptureCountdown);
    root.querySelector("#toggle").addEventListener("click", toggleVanished);
    root.querySelector("#collapse").addEventListener("click", () => {
      state.collapsed = true;
      updatePanel();
    });
    root.querySelector("#expand").addEventListener("click", () => {
      state.collapsed = false;
      updatePanel();
    });
    root.querySelector("#snap").addEventListener("change", (event) => {
      toggleSnap(event.target.checked);
    });
    root.querySelector("#sensitivity").addEventListener("change", (event) => {
      state.sensitivity = ["low", "medium", "high"].includes(event.target.value)
        ? event.target.value
        : "medium";
      savePrefs({ sensitivity: state.sensitivity });
    });
    root.querySelector("#thanos").addEventListener("change", (event) => {
      state.thanos = event.target.checked;
      savePrefs({ thanos: state.thanos });
    });
    root.querySelector("#gesture").addEventListener("change", (event) => {
      toggleGesture(event.target.checked);
    });

    const handle = root.querySelector("#drag-handle");
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const rect = host.getBoundingClientRect();
      drag = { pointerId: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const left = Math.max(4, Math.min(window.innerWidth - 60, event.clientX - drag.x));
      const top = Math.max(4, Math.min(window.innerHeight - 55, event.clientY - drag.y));
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    });
    const finishDrag = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      const rect = host.getBoundingClientRect();
      state.panelPosition = { left: rect.left, top: rect.top };
      savePrefs({ panelPosition: state.panelPosition });
    };
    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);
  }

  function applyPosition(host, position) {
    const left = Math.max(4, Math.min(window.innerWidth - 60, position.left));
    const top = Math.max(4, Math.min(window.innerHeight - 55, position.top));
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
  }

  function updatePanel() {
    if (!state.panel?.shadowRoot) return;
    const root = state.panel.shadowRoot;
    const enabled = state.enabled;
    const full = root.querySelector("#full");
    const collapse = root.querySelector("#collapse");
    const expand = root.querySelector("#expand");
    full.classList.toggle("hidden", state.collapsed || !enabled);
    collapse.classList.toggle("hidden", !enabled);
    expand.classList.toggle("hidden", !state.collapsed || !enabled);
    if (!enabled) {
      state.panel.style.display = "none";
      return;
    }
    state.panel.style.display = "block";

    const capture = root.querySelector("#capture");
    const retake = root.querySelector("#retake");
    const thumbnail = root.querySelector("#thumbnail");
    const emptyHint = root.querySelector("#empty-hint");
    const toggle = root.querySelector("#toggle");
    const dot = root.querySelector("#status-dot");
    capture.textContent = state.captureTimer
      ? `Step out of frame · ${state.captureCountdown}`
      : (state.hasBackground ? "Capture empty room again" : "Capture empty room");
    capture.disabled = Boolean(state.captureTimer);
    retake.classList.toggle("hidden", !state.hasBackground);
    thumbnail.classList.toggle("hidden", !state.hasBackground);
    emptyHint.classList.toggle("hidden", state.hasBackground);
    if (state.hasBackground && state.backgroundData) thumbnail.src = state.backgroundData;
    toggle.disabled = !state.hasBackground;
    toggle.textContent = state.vanished ? "Appear" : "Vanish";
    root.querySelector("#status-label").textContent = state.vanished ? "Vanished" : "Visible";
    dot.classList.toggle("vanished", state.vanished);
    root.querySelector("#snap").checked = state.snapEnabled;
    root.querySelector("#snap").disabled = !state.hasBackground;
    root.querySelector("#sensitivity").value = state.sensitivity;
    root.querySelector("#thanos").checked = state.thanos;
    root.querySelector("#gesture").checked = state.gestureEnabled;
    root.querySelector("#gesture").disabled = !state.hasBackground;
    root.querySelector("#gesture-status").textContent = state.gestureStatus;
    root.querySelector("#extension-state").textContent = state.snapStarting ? "Starting mic…" : "";
    state.panel.classList.toggle("disabled", !state.hasBackground);
  }

  installCameraWrapper();
  window.addEventListener("pagehide", () => {
    state.gestureEnabled = false;
    syncGestureDetection();
    state.snapEnabled = false;
    stopSnapDetection();
    window.clearInterval(state.captureTimer);
    state.captureTimer = null;
    for (const pipeline of [...state.pipelines]) cleanupPipeline(pipeline);
  });
  if (document.documentElement) ensurePanel();
  else document.addEventListener("DOMContentLoaded", ensurePanel, { once: true });
})();