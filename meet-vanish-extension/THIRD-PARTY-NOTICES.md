# Bundled local vision models

V-sign detection uses Google's MediaPipe Hand Landmarker entirely within the extension. The user approved adding this bundled dependency; no CDN is contacted at runtime.

- **MediaPipe Tasks Vision 0.10.21** — Apache License 2.0. Unmodified `vision_bundle.mjs` and SIMD/non-SIMD WASM runtime files come from the npm package `@mediapipe/tasks-vision`.
- Package source: https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.21.tgz
- Package SHA-512 (base64): `TuhKH+credq4zLksGbYrnvJ1aLIWMc5r0UHwzxzql4BHECJwIAoBR61ZrqwGOW6ZmSBIzU1t4VtKj8hbxFaKeA==`
- **Hand Landmarker float16 model, version 1** — distributed by Google as part of MediaPipe Solutions under Apache License 2.0.
- Model source: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- Model SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`
- **Selfie Segmenter float16 model, version 1** — Google's MediaPipe person/background model, processed entirely on-device by the same bundled Tasks Vision runtime.
- Model source: https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite
- Model SHA-256: `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`
- Model documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter
- Upstream project and license: https://github.com/google-ai-edge/mediapipe
- License text: `vendor/LICENSE.txt`

No modifications were made to the bundled vendor JavaScript, WASM, or model files. Meet Vanish's integration, gesture rules, and visual effect code are separate files.