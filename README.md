# Meet Vanish

An offline Chrome extension for Google Meet: capture your empty room, then vanish and reappear with an optional person-only dust effect.

**Version: 1.7.2.** The extension folder is byte-for-byte identical to the supplied v1.7.2 release. No v1.7.3 rendering changes are included. No compilation, API keys, or hosted backend are required.

## Features

- Captured empty-room image replaces your outgoing camera video.
- Reversible, source-colored dust effect.
- Button and **Alt+Shift+V** controls.
- Optional local finger-snap and V-sign detection.
- Original call audio tracks are preserved.
- Bundled on-device MediaPipe models; no runtime CDN downloads.

## Install

1. Download this repository as a ZIP and extract it.
2. Open `chrome://extensions` in Chrome 116 or newer.
3. Enable **Developer mode**, then choose **Load unpacked**.
4. Select the **`meet-vanish-extension`** folder, not the repository root.
5. Open or reload Google Meet and allow normal camera/microphone access.
6. Choose **Capture empty room**, step out during the countdown, then return.
7. Use **Vanish / Appear** or **Alt+Shift+V**. Enable dust, snaps, or V detection if wanted.

To replace a newer installation, replace its entire extension folder with this one, reload the extension in `chrome://extensions`, and reload Meet. This interrupts an active call, so update between calls.

See [the extension guide](meet-vanish-extension/README.md) for complete usage, privacy details, troubleshooting, and historical validation notes.

## Compatibility and limitations

This release targets **Google Meet in Chrome only**. It does not support Zoom, Teams, desktop applications, or a system virtual camera.

During dust, v1.7.2 renders at up to 1024×576 and scales the result to the outgoing resolution. This can soften high-resolution video. Segmentation can miss hair/hands or include room edges. Keep the camera and lighting stable when capturing the room.

Browser background throttling and device performance affect animation. Production Meet, actual remote participant output, and real-device smoothness are not established by the automated tests. Test with another device/participant before relying on it in a call.

## Development

Edit the extension files directly, reload the extension, then reload Meet. Models and runtime files are already bundled.

Run the dependency-free mocked regression suite from the repository root with Node.js 22 or newer:

```sh
npm test
```

It covers media lifecycle, audio identity, camera cleanup, gesture rules, offscreen ownership, dust timing, and safe GPU dispatch. It does **not** test actual WebGL output, gesture accuracy on a real person, or live Meet compatibility.

Package the installable extension with Python 3.9 or newer:

```sh
python3 scripts/package-release.py
```

The ZIP and SHA-256 sidecar are written to `dist/`. The packager verifies every bundled extension file against `checksums/extension-v1.7.2.sha256`; it refuses changed or extra files. Deliberate development changes require reviewing/updating that checksum list and version before release.

GitHub Actions runs the regression suite, checks JavaScript syntax and original-file integrity, and produces a downloadable extension artifact. It does not publish a release automatically.

## Upload to GitHub

See [GITHUB-UPLOAD.md](GITHUB-UPLOAD.md) for browser-upload and Git instructions, including release assets.

## Privacy

No analytics or remote processing are included. Captured room images and settings stay in local extension storage. Inference samples are transient. The page bridge uses same-window messaging and is not a security boundary against Meet-page scripts. Optional snap detection may request a separate microphone stream if a suitable call track is unavailable.

The repository contains extension code, bundled dependencies, documentation, tests, and packaging metadata—not your captured room image or Chrome settings.

## Licensing

Bundled MediaPipe files and model notices are preserved in [THIRD-PARTY-NOTICES.md](meet-vanish-extension/THIRD-PARTY-NOTICES.md) and [vendor/LICENSE.txt](meet-vanish-extension/vendor/LICENSE.txt).

**No license has been selected for the project's first-party code.** Publishing a public repository does not itself grant a general open-source license. Choose a license before inviting reuse; the vendor's Apache license does not automatically license this extension's own code.
