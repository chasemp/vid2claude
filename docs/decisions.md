# Decisions

Choices the plan left open, what the app does today, and how to change it.

## Answered by the plan's own numbers

| Decision | Setting | Where |
| --- | --- | --- |
| Frame interval | **2 s** | Settings, `frameIntervalSec` |
| Frame cap | **120** | Settings, `frameCap` |
| Scene-change threshold | **0.15**, minimum 0.75 s apart | Settings, `sceneThreshold`; `src/video/scene-change.ts` |
| Minimum spacing between kept frames | **0.4 s** | `MIN_SPACING_SEC` in `src/bundle/align.ts` |
| Default speech model | **whisper-tiny.en** | Settings, `model` |

These are the plan's proposals, shipped as defaults and exposed in the settings
panel, so a user with a long or a visually busy recording can change them
without a rebuild.

## User agent in README.md

**Shipped as a setting, default on.** It is genuinely useful — "iOS 26.1
Safari" often is the bug — and it is mildly identifying. Making it a toggle
costs one checkbox and removes the need to guess on the user's behalf. The
toggle only affects `README.md`; `transcript.json` never carries it.

## Default branch name for the GitHub export

**`repro/<date>`**, derived from the bundle folder: `repro-2026-08-31-1412`
becomes `repro/2026-08-31-1412`. Reasons: it sorts, it never collides with a
second bundle from the same day, and the `repro/` prefix groups them in branch
listings. The branch field in settings overrides it.

The commit lands via the Git Data API as **one commit containing the whole
bundle**, on a branch created from the repository's default branch if it does
not exist yet. An existing branch is fast-forwarded, never force-updated.

## Deliberate departures from the plan

- **The service worker does not cache model weights.** transformers.js already
  stores them in the Cache API under `transformers-cache`; mirroring a 250 MB
  model into a second cache would double the storage cost on a phone for no
  benefit. Offline second runs were verified with the model cache as it is.
- **onnxruntime's WebAssembly files are served from this origin**
  (`public/ort/`, populated by `scripts/copy-ort.mjs` at build time). Left
  alone, transformers.js fetches them from a public CDN at inference time,
  which would break both the offline promise and the "nothing leaves the
  device" promise. `VITE_HF_HOST` does the same for model weights when you want
  to remove the Hugging Face CDN too.
- **`sw.js` is hand-written plain JavaScript in `public/`**, not a bundled
  module. It is small, has no imports, and ships byte for byte as reviewed.
- **Transcription failure is not fatal.** A missing audio track, a container
  the browser will not decode, or a model that fails to load produces a warning
  and a bundle with frames and an empty transcript, rather than nothing.

## Not built, on purpose

- **ffmpeg.wasm audio fallback.** Assumption A1 is unverified for MP4 on real
  devices (see [spikes.md](spikes.md)). The 25–30 MB dependency is not paid for
  until a device shows it is needed; `AudioDecodeError.canRetryWithDemuxer` is
  where it would attach.
- **Recording, uploads, accounts, video in the bundle, diarization,
  translation, frame editing.** Non-goals in the plan; still non-goals.
