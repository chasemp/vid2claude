# Bundle format `repro-bundle/1`

This is the contract between the app and whatever reads the bundle. Anything
that reads a bundle should check `schema` and refuse a version it does not know.

The folder is named `repro-YYYY-MM-DD-HHMM`, in the local time of the device
that did the processing.

```
repro-2026-08-31-1412/
  README.md
  transcript.md
  transcript.json
  manifest.json
  frames/
    0001.png
    0002.png
    ...
```

## `README.md`

Written from a template plus the fields the user typed. Sections, in order:

1. `# <title>` — one line the user typed. Default: `Bug reproduction, <date>`.
2. `## Summary` — what they were trying to do and what went wrong. Omitted
   entirely when they wrote nothing.
3. `## How to read this bundle` — three sentences naming `transcript.md`,
   `frames/` and `manifest.json`.
4. `## Environment` — source file name, duration, resolution, frame count,
   transcription model and device, and the processing device's user agent.
   The user agent line is optional: it helps whoever debugs this and it mildly
   identifies the reporter, so it is a setting, defaulting to on.

## `transcript.md`

One line per segment, blank line between:

```
[00:03.4] So I open the settings screen.

[00:07.0] And I tap save.
```

Timestamps are `MM:SS.s`, with `HH:` prefixed only past an hour. When nothing
was transcribed the file says so in one italic line rather than being empty.

## `transcript.json`

```json
{
  "schema": "repro-bundle/1",
  "source": { "filename": "RPReplay_Final.mp4", "durationSec": 84.3, "width": 1179, "height": 2556 },
  "transcription": { "model": "onnx-community/whisper-small.en", "device": "webgpu" },
  "segments": [
    { "id": 1, "startSec": 0.0, "endSec": 3.4, "text": "So I open the settings screen." }
  ]
}
```

- `source.width` and `source.height` are display dimensions, after the
  browser has applied any rotation metadata.
- `segments[].id` starts at 1 and matches the array order.
- `startSec` never decreases. `endSec` is never before `startSec`.
- `transcription.model` is `"none"` and `device` is `"none"` when there was no
  transcription (the user turned it off, the recording had no audio track, or
  transcription failed — in which case the bundle still ships with its frames).

## `manifest.json`

```json
{
  "schema": "repro-bundle/1",
  "frames": [
    { "file": "frames/0001.png", "timeSec": 0.0, "reason": "segment-start", "segmentId": 1 },
    { "file": "frames/0002.png", "timeSec": 2.1, "reason": "scene-change", "segmentId": 1, "diffScore": 0.31 }
  ]
}
```

- `frames` is in time order, and `file` follows that order: `frames/0001.png`
  is the first entry, with no gaps.
- `reason` is one of:
  - `segment-start` — the moment a narration segment begins;
  - `scene-change` — the screen changed by more than the threshold;
  - `interval` — the fixed sampling interval, and the frame at 0 s;
  - `final` — the last frame of the recording.
- `segmentId` is the segment the frame falls inside, or the most recent one
  before it. Absent when there is no transcript.
- `diffScore` is present on `scene-change` frames: mean absolute pixel
  difference against the previous sample, 0 to 1.

## `frames/NNNN.png`

PNG, longest edge at most 1280 px, never upscaled, rotation applied. Four-digit
zero-padded names starting at `0001`.

## `debug.log` (optional)

Present only when the user turned on "include the run log in the bundle". A
plain-text log of the run: container details, this device's decoding support,
stage timings, and any frame that failed. Readers should ignore it; it is there
so a bug report can travel with the bundle. Credentials are scrubbed from it.

## Guarantees a reader can rely on

- Every file listed in `manifest.json` exists, and every PNG in the folder is
  listed.
- Frame times never go backwards and never exceed the recording's duration.
- Every segment has at least one frame carrying its `segmentId`, unless the
  frame cap forced segments to share — the validator reports that as a warning,
  not an error.

`npm run validate-bundle -- <zip-or-folder>` checks all of the above.
