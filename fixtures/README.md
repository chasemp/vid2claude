# Fixtures

Nothing in here except this file is committed.

## Generated fixtures

```sh
npm run fixtures     # node scripts/make-fixture.mjs fixtures
```

Writes synthetic screen recordings with known content, plus
`synthetic-truth.json` describing exactly what is in them: four flat-coloured
"screens" three seconds apart, each with a spoken line starting at the screen's
first frame. The spike harness asserts against that truth, so a scene-change or
frame-capture regression fails a check rather than a human's eye.

| File | What it is |
| --- | --- |
| `synthetic-portrait.mp4` | H.264 + AAC, 720x1280, 12 s — what a phone recorder writes |
| `synthetic-rotated.mp4` | The same, tagged with a 90 degree display matrix |
| `synthetic-portrait.webm` | VP8 + Opus, for browser builds without proprietary codecs |
| `synthetic-truth.json` | Screen changes and narration, with times |

Requires `ffmpeg` and `espeak-ng` on PATH.

## Real recordings

The test matrix in the plan calls for three real recordings (20 s, 90 s, 4 min)
with hand-checked transcripts for the first two. Put them here as
`real-short.mp4`, `real-typical.mp4`, `real-long.mp4`. They are gitignored:
a screen recording of a bug usually contains someone's account, messages or
files, and none of that belongs in a public repository.

## Real recordings and the spike harness

Drop a real phone recording in as `real-android.mp4` (or `.webm`, if the
harness browser has no H.264 decoder — `ffmpeg -i real-android.mp4 -c:v libvpx
-vsync passthrough -c:a libopus real-android.webm` keeps the variable frame
rate that makes a real recording different from the synthetic one). When
`real-android.webm` is present, `npm run spikes` runs the whole pipeline
against it and writes `real-bundle.zip` for inspection.

Everything here except this file is gitignored, and that matters: a screen
recording of a bug is a recording of someone's actual screen.

## Model mirror

```sh
node scripts/mirror-model.mjs onnx-community/whisper-tiny.en fixtures/hf-mirror
```

Downloads one model so the transcription spike can run without the browser
reaching the network:

```sh
VITE_HF_HOST=http://localhost:5199/fixtures/hf-mirror npm run spikes -- --with-transcription
```
