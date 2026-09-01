# Phase 0 spikes

The plan listed five assumptions that had not been checked against a primary
source. This is what came back, and what the app does about each one.

Everything here is reproducible:

```sh
npm run fixtures                 # synthetic recordings with known content
npm run spikes                   # writes docs/spike-results.json
npm run spikes -- --with-transcription   # adds the model download and a real ASR run
```

The spikes import the same modules the app ships (`src/audio/decode.ts`,
`src/video/frames.ts`, `src/bundle/zip.ts`, `src/pipeline.ts`), so a passing
spike is evidence about the app rather than about a demo written beside it.

## What ran, and where

| | |
| --- | --- |
| Browser | HeadlessChrome 141 (Playwright's Chromium build), Linux x86_64 |
| Ran at | 2026-09-01 |
| Raw results | [`spike-results.json`](spike-results.json) |

Two limits of this environment shape everything below, and neither is a
property of the app:

1. **This Chromium build has no proprietary codecs.** `canPlayType` returns `""`
   for `video/mp4; codecs="avc1.42E01E,mp4a.40.2"` and for `video/quicktime`.
   The harness therefore falls back to a VP8/Opus WebM fixture. The MP4 path —
   the one every phone recorder actually produces — could not be exercised
   here.
2. **Outbound TLS is intercepted.** Cross-origin requests from the browser fail
   with `ERR_CERT_AUTHORITY_INVALID` before any CORS decision is made, so
   nothing about a third-party API's CORS policy can be concluded from this
   machine's browser.

Both are why the device matrix at the bottom is still open. A phone is the only
place the phone answers can come from.

## Results

| | Assumption | Status | Where |
| --- | --- | --- | --- |
| A1 | `decodeAudioData` accepts the recording's container | **partly verified** | [below](#a1-audio-decoding) |
| A2 | `navigator.share({ files })` accepts a ZIP | **unverified** | [below](#a2-sharing-the-zip) |
| A3 | A client-side ZIP library streams megabytes without exhausting memory | **verified** | [below](#a3-zip-memory) |
| A4 | The GitHub REST API is usable from a browser | **verified from docs, not from here** | [below](#a4-github-from-a-browser) |
| A5 | Seeking a `<video>` and drawing to canvas yields the right frames | **verified on desktop** | [below](#a5-seeking-and-frames) |

Beyond the assumptions, the harness also checks the phase acceptance criteria it
can: scene changes land within 0.5 s of the fixture's known screen transitions,
a full run produces a bundle that passes `scripts/validate-bundle.ts`, and
transcription produces usable segments end to end.

### A1 audio decoding

**Claim:** `AudioContext.decodeAudioData` accepts an MP4/AAC container.

**What was checked:** `decodeToMono16k()` against the fixture, asserting the
result is 16 kHz mono with real signal in it.

**Outcome:** passes — 192,000 samples for a 12.0 s recording (exactly 16 kHz),
peak amplitude 0.73, RMS 0.081, 105 ms to decode and resample.

**Caveat that matters:** the fixture that ran was **WebM/Opus**, not MP4/AAC,
because this browser build cannot decode AAC at all. So what is verified is the
decode-and-resample path, not the container question A1 was actually asking.
MP4/AAC support in `decodeAudioData` remains open on every real target browser.

**Decision:** ship the `decodeAudioData` path, and treat a decode failure as
non-fatal. `AudioDecodeError` carries `canRetryWithDemuxer`, the pipeline
catches it, warns the user, and still writes a bundle with frames and an empty
transcript. That means a browser that turns out to reject MP4 degrades to a
useful bundle instead of no bundle. If a real device fails here, the fallback is
an in-browser demuxer (ffmpeg.wasm, roughly 25–30 MB) wired in behind that same
error — deliberately not paid for until a device says it is needed.

### A2 sharing the ZIP

**Claim:** `navigator.share({ files })` works for a ZIP on iOS Safari and
Chrome on Android.

**Outcome:** unverifiable here. Headless Chromium has no `navigator.share` at
all (`hasShare: false`), and a desktop result would not predict a phone anyway.

**Decision:** the download button is always present; the share button is
rendered only when `navigator.canShare({ files: [zip] })` returns true for the
actual ZIP file object. Feature detection, not user-agent guessing, so a browser
that refuses `application/zip` simply never shows the button.

### A3 ZIP memory

**Claim:** a client-side ZIP library can stream a multi-megabyte archive on a
phone without exhausting memory.

**What was checked:** 40 entries of 1 MB of incompressible data, generated one
at a time and stored (not deflated), through `createZip()`.

**Outcome:** verified. 40.0 MB in, 40,005,382 bytes out, 289 ms, JS heap 4.2 MB
before and 44.4 MB at peak.

**Reading of that number:** peak heap tracks the size of the finished archive,
because the output chunks are held until the `Blob` is constructed; it does not
track the number of entries. A 15 MB bundle (the Phase 1 target) costs about
15 MB of heap. A 4-minute recording at the 120-frame cap is the same order.
Frames are stored rather than deflated, so no CPU is spent recompressing PNGs.

### A4 GitHub from a browser

**Claim:** the GitHub REST API can create a commit from a browser with a
fine-grained token, and CORS permits it.

**Outcome from this machine's browser:** nothing conclusive. Both the simple GET
and the preflighted POST failed with `ERR_CERT_AUTHORITY_INVALID`, i.e. the
sandbox's TLS interception, before CORS was ever evaluated. The harness reports
this as a skip rather than a failure.

**What could be checked here:** the same request from `curl`, which does trust
the sandbox CA, returns `200` with `Access-Control-Allow-Origin: *` on
`GET https://api.github.com/repos/{owner}/{repo}` with an `Origin` header set —
consistent with GitHub documenting CORS support for the REST API. The `OPTIONS`
preflight could not be tested: the sandbox proxy answers `OPTIONS` itself with
`405`.

**Decision:** `src/export/github.ts` implements the Git Data API sequence —
read the repo, read (or create) the branch ref, upload each file as a blob,
build one tree, create one commit, move the ref — so a bundle lands as a single
commit. Endpoint shapes follow GitHub's documented Git Database API. The
remaining risk is the preflight, and the first real run on a phone settles it;
the failure would be loud and immediate rather than subtle. The token lives in
IndexedDB, is sent only as an `Authorization` header to `api.github.com`, and is
never written into a bundle or logged.

### A5 seeking and frames

**Claim:** seeking a `<video>` frame by frame and drawing to canvas produces
correct frames for phone screen recordings.

**What was checked:** the fixture holds four flat-coloured screens for three
seconds each. The spike seeks to the middle of each screen, encodes a PNG
through the shipping capture path, and checks which of the four known screen
colours the decoded pixel is nearest.

**Outcome:** verified on this browser — all four frames landed on the right
screen, reported duration 12.008 s against a true 12.0 s, and the frame size
followed the 1280 px rule.

**Not verified:** rotation metadata. The rotated fixture is H.264, which this
browser cannot decode, so `A5b` is skipped. Whether `videoWidth`/`videoHeight`
come back already rotated is still an open question on iOS and Android, and it
is the one that decides whether portrait recordings appear upright.

**Decision:** the capture path resolves a seek on `seeked` and then waits for
`requestVideoFrameCallback` where it exists, so the frame is painted before it
is read, with a 3 s guard for browsers that drop a seek near the end of file.
Variable frame rate is handled by seeking to times rather than counting frames.
Duration is re-probed when a file reports `Infinity`, which iOS recordings do.

## Phase acceptance checks that could run here

| Check | Outcome |
| --- | --- |
| Scene changes within 0.5 s of the three known screen transitions | pass, on both scan strategies |
| Full run produces a bundle that passes the validator | pass — 9 frames, valid structure, 317 KB |
| Transcription end to end (whisper-tiny.en) | pass — see below |

### The two scan strategies

Scene detection has two paths: fast muted playback driven by
`requestVideoFrameCallback` (one linear decode pass), and seek-per-sample for
browsers without it, Firefox among them. The harness runs both by deleting
`requestVideoFrameCallback` for one of the runs.

| Strategy | Time for the 12 s fixture | Distance from the true transitions |
| --- | --- | --- |
| playback at 8x | 4,542 ms | 0.10 s, 0.13 s, 0.37 s |
| seek at 4 fps | 723 ms | 0.00 s, 0.00 s, 0.00 s |

Seeking was both faster and exact here, which is the opposite of the reason the
playback path exists. Two things to keep in mind before reading much into it:
the fixture is 12 seconds of 720x1280 VP8, and seek cost grows with the number
of samples (4 per second, so 960 seeks for a 4 minute recording) while playback
cost is bounded by duration divided by the rate. The default stays playback
because its cost is bounded; **this is worth re-measuring on a phone with a
90 second recording**, and switching the default is a one-line change in
`detectSceneChanges`.

### Transcription

The transcription run used a local mirror of `onnx-community/whisper-tiny.en`
(`scripts/mirror-model.mjs`) because the browser cannot reach the Hugging Face
CDN through this sandbox. It selected the **WebGPU** backend, took 160 s wall
clock for a 12 s recording on a software GPU, and returned:

| Spoken (truth) | Transcribed |
| --- | --- |
| 0.0 s "So I open the settings screen." | 0.0 s "So I open the settings screen and I tap the save button." |
| 3.0 s "And I tap the save button." | (merged into the segment above) |
| 6.0 s "Now it kicks me back to the login page." | 5.0 s "Now it kicks me back to the login page." |
| 9.0 s "I open settings again and my change is gone." | 9.0 s "I open settings again and my changes gone." |

Words are right; boundaries are coarse. `whisper-tiny.en` merged two adjacent
sentences and put one boundary 1.0 s early, against the plan's 0.5 s target.
That is the model, not the plumbing: tiny quantises timestamps coarsely, and the
fixture's synthetic speech has no natural pauses. Larger models are offered in
settings for exactly this. **The 0.5 s acceptance criterion is not signed off
until it is re-run on a device with real speech**; what is signed off is that
the pipeline produces monotonic, non-overlapping, correctly clamped segments
from real model output.

## PWA behaviour

`npm run check-pwa` builds nothing itself; it drives `dist/` through a real
browser with a real service worker. All six checks pass on HeadlessChrome 141:

- the service worker takes control,
- the app shell loads with the network switched off,
- the stylesheet is served from cache too,
- a multipart POST to `./share-target` stashes the file,
- the endpoint redirects to `./?share-target=1`,
- and the app claims the stashed file on the next load and shows its name.

What that does **not** cover is Android's half of the share contract: whether
the OS actually offers the installed app in the share sheet for a video. That
needs a phone.

## When a browser refuses a recording

A real Android phone rejected a 61 MB `.mp4` with `MEDIA_ERR_SRC_NOT_SUPPORTED`
(media error 4), which is all a `<video>` element ever says. That is not enough
for anyone to act on, so `src/video/probe.ts` reads the container directly —
walking the boxes by their headers and reading only `moov`, so a 61 MB file
costs a few kilobytes of reads — and `src/video/diagnose.ts` pairs what is
inside the file with what the browser claims it can decode.

The parser is checked against real muxer output in `tests/fixtures/` (a few
kilobytes each, committed): H.264+AAC, HEVC+AAC, AV1+AAC, a file carrying a 90
degree display matrix, and a WebM that must come back as "not an MP4".

The end-to-end path is checked too, and honestly: Playwright's Chromium has no
H.264 or HEVC decoder, so it refuses these files exactly as a phone without an
HEVC decoder does, with the same error and no further detail. Both spikes pass:
the HEVC file produces "This recording is HEVC (H.265), and this browser cannot
decode it on this device" plus how to re-record in H.264, and the H.264 file
produces a message about the browser rather than the recording.

What this does **not** do is decode anything the browser cannot. If a real
device reports HEVC, the only in-browser fix is a software decoder
(ffmpeg.wasm, roughly 25-30 MB), and that is a decision to take with a real
answer in hand rather than on a guess.

## Still to check on real devices

Nothing below can be answered from CI. Fill in a row when a device says so.

| Device / OS / browser | A1 MP4 audio decodes | A2 shares a ZIP | A5 frames correct | A5b rotation upright | WebGPU used | 90 s recording: time and peak memory |
| --- | --- | --- | --- | --- | --- | --- |
| iPhone, iOS 26+, Safari | | | | | | |
| iPhone, older iOS, Safari (WASM path) | | | | | | |
| Android phone, Chrome | | | | | | |
| macOS, Safari | | | | | | |
| Desktop, Chrome | | | | | | |

Use the real recordings described in [`fixtures/README.md`](../fixtures/README.md)
and the Phase 1 acceptance target: an 84 s iPhone recording, under 15 MB, under
60 seconds, on the phone.
