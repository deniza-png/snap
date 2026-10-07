# Meet Vanish

A local-only Chrome extension that replaces your outgoing Google Meet camera image with a captured still of your empty room. It does not modify call audio or send data anywhere.

## Install

1. Download and unzip the extension package.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose the unzipped `meet-vanish-extension` folder (the folder containing `manifest.json`).
5. Open a Google Meet call or the pre-join camera preview and allow camera and microphone access as usual.

Chrome 116 or newer is required for MAIN-world content scripts and the local offscreen hand detector.

**Already had Meet open when you installed? Reload the Meet tab.** The toolbar popup can work before the page's camera wrapper and floating panel have been injected. Reloading an active call may briefly reconnect it.

### Updating an existing installation

Version 1.1.0 includes a new silhouette dust effect and optional V-sign detection. Version 1.0.1 fixed panel creation under Trusted Types enforcement. Unzip the new package, replace **all files and folders** in the folder you loaded into Chrome (including `vendor` and `models`), click the extension's reload button on `chrome://extensions`, and reload the Meet tab.

Version 1.1.1 fixes the premature blurred/ghosted dust appearance: the first frame matches the full-resolution camera snapshot, untouched areas stay fully opaque, and grains break away with a crisp removal stencil rather than a soft confidence-weighted fade. V detection, snapping, and camera behavior are unchanged.

Version 1.2.0 uses bundled, on-device person segmentation for Thanos dust. Only person pixels can produce grains; the saved room remains a separate untouched layer. Reappearance runs the same grain sequence in reverse. Replace the complete package, including the new `models/selfie_segmenter.tflite`.

Version 1.3.0 replaces square flecks with smaller anti-aliased circles, continuous size variation, gradual particle birth/fade, and gentler wind. The person layer now draws the live raw camera every render, not a frozen snapshot. During an active effect, the local silhouette is refreshed about every 180 ms with at most one pending request per pipeline. Detached grains keep their launch positions/colors, while returning particles follow the moving person.

Circular sprites are cached with transparent padding to avoid color bleeding. Full-resolution compositing is restricted to the current person's bounds instead of repeatedly processing the entire camera frame.

Version 1.4.0 starts the sweep synchronously on toggle, without awaiting a new mask. While Thanos is enabled, a small local silhouette cache is kept warm. The front starts at the person's side, moves in one ordered direction, and reveals the saved room behind it. The unswept part is the original fully opaque live camera image—not a low-resolution whole-person cutout. Segmentation now selects grain origins only, so a late/missing mask cannot blur or punch holes in the still-visible body. The front is fixed for the transition and does not jump when segmentation updates.

## Use

**Version 1.7.2 makes the person-only dust smoother without a line swap.** Each removed person cell releases its larger source-colored grain plus two finer fragments; a locally softened birth field rounds out blocky vacancies. Grain births loosely favor the right side for the reference's partly intact silhouette, but remain scattered on both sides: there is no hard cut line or whole-room swap. Grains ease into their motion and fade individually, while untouched person pixels remain opaque and the saved room stays fixed. The outgoing track remains 30 fps; during dust only, the GPU pass is capped at 1024×576 and upscaled to the original stream dimensions to bound work on high-resolution cameras. Normal camera and fully vanished frames stay at their original resolution. Reversing starts from the last frame actually displayed. This is a rendering change, not a promise of a particular frame rate on every device.

**Version 1.7.1 keeps the approved grain transport and fixes the upside-down saved room.** Captured `ImageBitmap` backgrounds are normalized to a DOM canvas before their GPU upload, so the room, live video, silhouette, and final room image all have the same top/bottom orientation. Grain cell spacing and diameter are doubled versus 1.7.0 (5–7.5 pixels at the renderer's native resolution, before display scaling), using one quarter as many grains. Birth timing, wind, source colors, and reverse paths are unchanged.

**Version 1.7.0 replaces the incorrect whole-image dissolve in 1.6.0 with GPU grain transport.** The captured room is a fixed background during the effect: it is never dotted, faded, or clipped by a moving boundary. The live detected person is fully opaque until individual grains detach. Each detached grain carries that source pixel's color and travels upward/right, leaving the saved room visible in its original location. There is no extra decorative cloud over a fading person. The same birth map controls removal and flight. Reappearance reverses those same paths.

The detector threshold is more inclusive, with one model-pixel of silhouette expansion to reduce missed hair/body edges. Remaining attached person pixels are LIVE, not a frozen portrait; detached grain colors come from a small-duration launch snapshot. If the first valid mask has not arrived, the live camera remains visible instead of graining the whole room. GPU support is required; an unavailable renderer is reported and uses an instant switch, not a disguised fade.

1. In the Meet page's floating panel, choose **Capture empty room**.
2. Step out of frame during the visible three-second countdown. The captured JPEG stays in `chrome.storage.local` on this device.
3. Return to frame and select **Vanish / Appear**, or press **Alt+Shift+V**. Select it again to return to live video.
4. Optional: turn on snap detection and grant microphone access if Chrome asks. The sensitivity setting affects snap detection only.
5. Optional: enable **Thanos dust** for roughly 2.2 seconds of simultaneous fine-grain breakup. It starts on toggle without a mask-preparation pause. Reappearing runs the effect backwards; reversing mid-animation reuses the existing cloud. Stay in frame—you do not need to physically move away during the effect.
6. Optional: enable **V-sign detection**, wait for the local model to load, and hold your index and middle fingers apart in a V with your ring and pinky folded for about 0.7 seconds. Lower your hand for at least half a second, then show V again to reappear. A 2.3-second cooldown prevents rapid repeated triggers.

The panel can be dragged, collapsed to its small round button, and repositioned later. Use **Retake** to replace the saved room image.

## Tips

- Capture with the same lighting you expect during the call.
- Keep the camera still; moving the laptop or camera changes the room framing.
- Test snap sensitivity in the Meet preview before joining.
- For V detection, keep Meet visible and put your whole hand clearly in frame. Either hand works; point your palm generally toward the camera. It checks the raw camera even while the outgoing video shows the saved empty room. It does not request an additional camera or microphone.
- Dust keeps the captured room fixed and uses local segmentation for the person only. Remaining attached pixels stay sharp and live; detached grains move rather than simply disappear through noise. Model mistakes can still clip hair/hands or include a room edge. Capture with consistent framing/lighting: switching from the live room to the fixed saved room at the start can show an exposure/framing difference. Capture a genuinely empty room: any person already in that photograph will remain in it.
- Snaps are detected locally from microphone audio. The detector uses a high-pass filter, an adaptive noise baseline, a short transient test, and a one-second debounce. Loud claps or other sharp sounds can still resemble a finger snap; use the button or shortcut when that matters.
- The optional snap detector first tries an enabled audio track Meet already requested. If none is available, it requests a separate microphone stream with browser noise processing disabled. Turning snap detection off releases that separate stream.

## Privacy and behavior

- No analytics, remote services, or runtime Internet requests. Optional hand tracking and person segmentation use bundled MediaPipe JavaScript, WASM, and local models. See `THIRD-PARTY-NOTICES.md`.
- V detection samples small JPEGs of the raw camera at about 6–7 fps. Samples are processed in an offscreen extension document, not saved or uploaded by the extension. The local bridge uses same-window `postMessage` and Chrome runtime messaging; Meet-page scripts can observe the same-window messages, so this bridge is not a security boundary against the page. Disabling V detection stops its sampling; the model document closes when no tab owns V detection or enabled Thanos.
- With a captured room and Thanos enabled, dust samples the raw camera at most once per 360 ms while idle and once per 180 ms during an effect, with at most one pending mask per pipeline. Samples are transient; only a small binary silhouette is cached in memory until camera cleanup. Nothing is saved or uploaded, and no additional camera/microphone is requested. The shared model stays warm while Thanos or V detection owns it. Mask sampling pauses in hidden tabs; browser/device throttling can affect smoothness.
- The captured image and settings remain in local Chrome extension storage.
- The outgoing stream uses a canvas video track and the original Meet audio tracks unchanged. If canvas setup fails, the original camera stream is returned untouched.
- The extension tracks the returned video track and clones created through its track/stream `clone()` methods. Once all tracked output video tracks stop, it releases the raw camera and drawing timers. It also checks for stopped tracks on each draw because browser `stop()` does not emit an `ended` event. Switching cameras is handled by wrapping each new `getUserMedia` video request.
- While visible, drawing uses `requestAnimationFrame`. In a hidden tab, a 33-ms timer requests redraws as a best-effort fallback. Chrome may throttle timers or suspend a tab; no extension can guarantee uninterrupted 30-fps delivery in every background/power-saving condition.
- Disabling the extension hides the panel and turns off the visual effect. Since Meet already has a canvas-backed track in an active call, reconnect the camera (or rejoin Meet) to return to a direct camera stream.
- Snap detection needs an available microphone. It does not upload or record audio.

## Troubleshooting

- If the controls do not appear, make sure the URL is on `meet.google.com`, the extension is enabled, and Chrome is 116+. Reload the Meet tab after installing or enabling the extension.
- If no room thumbnail appears, allow camera access and capture again from the Meet preview.
- If the call shows a frozen or black image, toggle the camera off and on in Meet or rejoin; check the page console for `[Meet Vanish]` warnings. For verbose logging, change `DEBUG` to `true` at the top of `main-world.js`, reload the extension, then reload Meet.
- If the shortcut is assigned to another extension, open `chrome://extensions/shortcuts` and change its assignment.

## Files

- `manifest.json` — Manifest V3 configuration and early content-script injection
- `main-world.js` — camera stream replacement, transitions, snap detection, and floating panel
- `bridge.js` — isolated-world storage and shortcut bridge
- `background.js` — service worker for the keyboard command
- `popup.html`, `popup.css`, `popup.js` — extension popup and enable switch
- `icons/` — extension icons
- `dust-effect.js` — semantic person-only fine-particle dissolve and reverse re-formation
- `grain-transport.js` — WebGL source-color grain transport and fixed-background compositing
- `gesture-rules.js` — V pose and hold/release rules
- `gesture-engine.js`, `gesture-offscreen.html` — local hand/person inference outside Meet's UI thread
- `vendor/`, `models/` — bundled local MediaPipe runtime, hand model, and person model

## Validation

The package was syntax-checked and tested with mocked browser media APIs for stream replacement, untouched audio, track/stream clones, camera shutdown, initialization rollback, hidden-tab scheduling, microphone cancellation, and raw-camera gesture sampling. Separate tests cover V pose rules, hold/release/cooldown, shared offscreen ownership across worker restarts, and the foreground/dust renderer.

An installed-extension smoke test in Chromium 152 verified local hand/person model loading, binary silhouette output, early MAIN injection on an intercepted local Meet-origin fixture with Trusted Types enforcement, fake-camera replacement, room capture, both local inference bridges, rapid V-detector off/on, and model shutdown after camera stop. Synthetic pixel comparisons verify sharp subject detail, no grains from changed room textures, exact reverse re-formation, and dust completion on an opaque canvas. No runtime Internet requests from the detectors were observed. This did **not** measure real-person segmentation accuracy, test a real person's hand, the production Meet app, or what another participant receives.

For 1.3.0, 32 media/integration, 8 background-lifecycle, and 9 gesture tests passed, plus dust helper and installed-Chromium checks. Additional synthetic checks verify changed live-camera pixels, moved silhouettes, transparent-corner circular sprites, and unchanged reverse rendering. The optimized renderer averaged 26.2 ms/frame over 20 synthetic 1920×1080 renders in this test environment (renderer only, after warm-up); this is not a live-call frame-rate guarantee.

For 1.4.0, 33 media/integration, 8 lifecycle, and 9 gesture tests passed, plus helper and installed-Chromium checks. These cover synchronous transition start before a model response, an idle mask cache, an ordered monotonic sweep, grain emission within the first 3% of a prepared synthetic sweep, and deliberately dropped masks leaving the unswept face's pixels unchanged. The renderer averaged 15.9 ms/frame over 20 synthetic 1920×1080 renders after sequential warm-up in this environment; this excludes real camera decoding, production Meet, and concurrent inference costs and is not a frame-rate guarantee. Real-person accuracy and remote-participant behavior still require testing on your device.

For 1.5.0, the helper and installed-Chromium tests passed, including deliberately different room colors on BOTH sides of the subject staying unchanged mid-animation, live detail remaining sharp, circular sprites, reversal, and the final saved room. The synthetic 1920×1080 renderer averaged 38.2 ms/frame over 20 warm renders in this environment, excluding camera decoding, production Meet, and concurrent inference. This correction costs more compositing work than 1.4.0; real-call smoothness and person-mask quality remain device-dependent and unverified.

For 1.6.0, helper and installed-Chromium tests passed. New checks verify simultaneous grain removal on both sides, exactly sharp surviving live pixels, live camera changes, and zero residual raw-camera pixels at 94% completion with the entire person intentionally omitted from the model. Circular flying sprites, reversal, final saved-room output, inference, camera shutdown, and offline operation also passed. The synthetic 1920×1080 renderer averaged 37.9 ms/frame after warm-up in this environment. These are fixture checks, NOT a verified natural-looking production Meet recording or a real-call frame-rate guarantee.

For 1.7.0, installed-Chromium checks verify the actual WebGL renderer, source-colored shirt grains moving outside the original body, fixed room pixels on BOTH sides, exact reverse, live attached detail, and the saved-room endpoint. The deprecated CPU whole-frame dissolve has been removed, and timing/dispatch tests replace its old mocked renderer tests. The headless software GPU averaged 85.0 ms/frame at synthetic 1920×1080 after optimization; hardware-GPU performance and real-call appearance are unverified. This is NOT a 30-fps guarantee. A supplied-reference simulation also uses the actual local person model and this renderer; it is not a recording from Meet.

For 1.7.1, Chromium regression tests use a REAL `ImageBitmap` saved room with different red top and green bottom markers, plus a canvas saved room. Both retain orientation during grain transport; the final room frame matches too. The fixed-room, escaped source-colored grains, live attached pixels, reversal, inference, offline, and camera-cleanup checks passed. Grain diameter is explicitly checked as twice the old value. Real-device smoothness still requires testing.

For 1.7.2, a Chromium WebGL test checks both sides of the person dissolving at once, denser multi-size grains, upright fixed room, sharp surviving live detail, deterministic reverse and the 1024×576 effect bound at 1080p. The synthetic headless software renderer averaged 43.6–55.3 ms/frame across two warm runs at 1080p input; this excludes production Meet, camera capture, and concurrent inference. Real hardware may be faster or slower; it has not been tested in a call. Media tests cover bounded draw cadence and immediate reverse without a displayed-frame jump.

After loading it in Chrome, test with another participant/device:

1. In the pre-join preview, capture the room and confirm both button and shortcut transitions.
2. In a call, confirm the other participant sees the empty-room image while your call audio continues normally.
3. Switch cameras, retake the room image, and test again.
4. Hide the tab for several minutes and check the remote video; Chrome's throttling behavior depends on the device and browser settings.
5. Leave the call and confirm the camera light turns off.
6. Test snaps, typing, speech, and claps at your microphone. Start on Medium, lower sensitivity if false triggers occur, or turn snap detection off.
7. Enable V detection. Confirm V toggles once, continuing to hold it does not repeat, and lowering/repeating the gesture makes you reappear.
8. Enable Thanos dust and check both dissolve and re-formation on the other device. The room should not create grains. Retake the room image if framing or lighting has changed.

The transient detector rejects low-level key taps and sustained sounds in its mocked tests, but it cannot reliably distinguish every clap, key tap, or other sharp noise from a finger snap.