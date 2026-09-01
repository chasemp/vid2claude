# vid2claude

Record a bug on your phone, narrating as you go. Hand the recording to this app.
Get back a ZIP you can drop into your repository, and Claude Code will know what
you did, what you said, and what the screen showed, in order.

Claude Code cannot watch a video, and a cloud session only sees files that are
committed. This app closes that gap. It is a PWA: install it to your home
screen and it works offline. Everything runs in the browser — **the recording
never leaves the device**, there is no server and there is no account.

## Using it

1. Record with your phone's or laptop's own screen recorder. Talk while you do
   it: say what you are trying to do and what you expected.
2. Open the app, choose the file. On Android, share the recording to the
   installed app instead.
3. Wait. It samples the screen for changes, transcribes your narration on the
   device, and writes the bundle.
4. Download the ZIP and unzip it into your repository, or let the app commit it
   to a branch for you.
5. Tell Claude Code: `Read repro-2026-08-31-1412/README.md and follow it.`

Install [`repo-kit/`](repo-kit/) into the repository you are debugging so Claude
knows how to read a bundle. See that folder's README.

## What comes out

```
repro-2026-08-31-1412/
  README.md          your title and summary, plus the recording's environment
  transcript.md      the narration, one timestamped line per segment
  transcript.json    the same with exact times
  manifest.json      every frame: time, why it was captured, which segment it belongs to
  frames/0001.png    screenshots, in time order
```

Frames are captured at the start of each narration segment, at each visual
change on screen, and at a fixed interval; they are PNG, longest edge 1280 px.
The full contract is in [docs/bundle-format.md](docs/bundle-format.md), and
`npm run validate-bundle -- <zip-or-folder>` checks a bundle against it.

## Why it works this way

- **No recording in the browser.** `getDisplayMedia` is unsupported in Safari on
  iOS, Chrome for Android, Firefox for Android and Samsung Internet, so a web
  page cannot capture a phone's screen. The OS recorder does that job; this app
  only processes what it produced.
- **The file picker is the primary intake.** Share-target registration is a
  Chromium-only manifest feature, so Android gets the share sheet as an
  enhancement and iOS gets the picker.
- **Transcription runs on the device.** Whisper via transformers.js, on WebGPU
  where the browser has it and WebAssembly where it does not.
- **No video in the bundle.** Claude Code reads images and text. The MP4 stays
  on your device unless you commit it yourself.

Sources for each of these, and what is verified versus assumed, are in
[docs/spikes.md](docs/spikes.md). Settings, defaults and the choices behind them
are in [docs/decisions.md](docs/decisions.md).

## Developing

```sh
npm install
npm run dev            # http://localhost:5173
npm test               # unit tests
npm run typecheck
npm run build          # dist/, a static site

npm run fixtures       # synthetic recordings with known content (needs ffmpeg, espeak-ng)
npm run spikes         # drives the real modules in a real browser, writes docs/spike-results.json
npm run check-pwa      # offline reload and the share-target endpoint, against dist/
```

`npm run spikes -- --headed` shows the browser. Add `--with-transcription` to
include the model download and a full speech-to-text run.

## Deploying

`.github/workflows/pages.yml` typechecks, tests, builds, runs the PWA checks
against the built artifact, and deploys it to GitHub Pages on every push to
`main`. It needs **Settings → Pages → Source: GitHub Actions** (not "Deploy from
a branch" — the repository root holds sources, not a built site).

The build uses relative URLs throughout, so the app works at a domain root and
under a project subpath such as `https://<user>.github.io/vid2claude/` without
configuration. `npm run check-pwa` serves the built site under a subpath by
default for exactly that reason.

Two notes about Pages specifically:

- It cannot send `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`
  headers, so the page is not cross-origin isolated and the WebAssembly backend
  runs single-threaded. WebGPU, the path most phones will take, is unaffected.
  A host that can set those two headers makes the WASM fallback faster.
- The app must be served over HTTPS. Service workers, and therefore offline use
  and the Android share target, do not exist on plain HTTP.

The app is a static site: `dist/` can be served from anywhere that speaks
HTTPS. Model weights are fetched from the Hugging Face CDN on first use and
cached by transformers.js; the onnxruntime WebAssembly files are served from
this origin (`public/ort/`, populated by `scripts/copy-ort.mjs`) so no CDN is
involved at inference time. Point `VITE_HF_HOST` at a mirror to remove the CDN
entirely.

## Layout

```
src/
  intake/     file picker, drag and drop, Android share-target receiver
  video/      frame capture and scene-change detection
  audio/      MP4 to 16 kHz mono, Whisper in a worker, segment cleanup
  bundle/     frame planning, the bundle's text files, ZIP writing
  export/     download, Web Share, commit to GitHub
  ui/         the interface
public/sw.js  offline shell and the share-target endpoint
spikes/       assumption checks that run against the real modules
repo-kit/     files to install into the repository you are debugging
```
