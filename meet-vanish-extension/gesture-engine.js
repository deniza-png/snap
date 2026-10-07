import { FilesetResolver, HandLandmarker, ImageSegmenter } from "./vendor/vision_bundle.mjs";

let modelPromise = null;
let busy = false;
let segmenterPromise = null;

async function segmentPerson(image) {
  let bitmap = null;
  let result = null;
  try {
    if (typeof image !== "string" || image.length > 250_000 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)) throw new Error("Invalid sample.");
    if (!segmenterPromise) {
      segmenterPromise = (async () => {
        const files = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("vendor/wasm"));
        return ImageSegmenter.createFromOptions(files, {
          baseOptions: {
            modelAssetPath: chrome.runtime.getURL("models/selfie_segmenter.tflite"),
            delegate: "CPU"
          },
          runningMode: "IMAGE",
          outputCategoryMask: false,
          outputConfidenceMasks: true
        });
      })().catch((error) => { segmenterPromise = null; throw error; });
    }
    const model = await segmenterPromise;
    const bytes = Uint8Array.from(atob(image.split(",")[1]), (char) => char.charCodeAt(0));
    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    if (bitmap.width > 512 || bitmap.height > 512) throw new Error("Sample too large.");
    result = model.segment(bitmap);
    // The bundled selfie model labels background=0 and person=1.
    const confidence = result.confidenceMasks?.[1] || result.confidenceMasks?.[0];
    if (!confidence) throw new Error("Person mask missing.");
    const probabilities = confidence.getAsFloat32Array();
    const width = confidence.width;
    const height = confidence.height;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = probabilities[i] >= 0.35 ? 255 : 0;
    // Encode only a binary silhouette, not another video frame. All temporary
    // model results and camera bytes are released after this response.
    let encoded = "";
    for (let i = 0; i < mask.length; i += 8192) {
      encoded += String.fromCharCode(...mask.subarray(i, i + 8192));
    }
    return { ok: true, width, height, mask: btoa(encoded) };
  } catch (error) {
    console.warn("[Meet Vanish] Local person segmentation failed.", error);
    return { ok: false, error: "Local person model unavailable." };
  } finally {
    result?.close();
    bitmap?.close();
  }
}

async function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const files = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("vendor/wasm"));
      return HandLandmarker.createFromOptions(files, {
        baseOptions: {
          modelAssetPath: chrome.runtime.getURL("models/hand_landmarker.task"),
          delegate: "CPU"
        },
        runningMode: "IMAGE",
        numHands: 2,
        minHandDetectionConfidence: 0.65,
        minHandPresenceConfidence: 0.65,
        minTrackingConfidence: 0.65
      });
    })().catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

async function detect(image) {
  if (busy) return { ok: true, skipped: true };
  busy = true;
  let bitmap = null;
  try {
    if (typeof image !== "string" || image.length > 250_000 ||
        !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image)) {
      throw new Error("Invalid local camera sample.");
    }
    const model = await loadModel();
    const bytes = Uint8Array.from(atob(image.slice(image.indexOf(",") + 1)), (char) => char.charCodeAt(0));
    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    if (bitmap.width > 512 || bitmap.height > 512) throw new Error("Camera sample exceeds size limit.");
    const result = model.detect(bitmap);
    const isV = (result.landmarks || []).some((landmarks, index) => {
      const points = result.worldLandmarks?.[index] || landmarks.map((point) => ({
        x: point.x * bitmap.width / bitmap.height,
        y: point.y,
        z: point.z * bitmap.width / bitmap.height
      }));
      return globalThis.MeetVanishGestureRules.isVSign(points);
    });
    return { ok: true, isV, handPresent: Boolean(result.landmarks?.length) };
  } catch (error) {
    console.warn("[Meet Vanish] Local hand tracking failed.", error);
    return { ok: false, error: "Local hand model unavailable. Toggle V detection to retry." };
  } finally {
    bitmap?.close();
    busy = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== "MEET_VANISH_OFFSCREEN") return false;
  if (message.type === "DETECT_V_SIGN") detect(message.image).then(sendResponse);
  else if (message.type === "SEGMENT_PERSON") segmentPerson(message.image).then(sendResponse);
  else return false;
  return true;
});