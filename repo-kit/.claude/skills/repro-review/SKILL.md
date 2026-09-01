---
name: repro-review
description: Read a reproduction bundle (a repro-YYYY-MM-DD-HHMM folder containing README.md, transcript.md, manifest.json and frames/) and reconstruct what the person did, said and saw before touching any code. Use whenever a task points at such a folder, mentions a repro bundle, or asks what a screen recording showed.
---

# Reviewing a reproduction bundle

A reproduction bundle is a screen recording that has been turned into text and
screenshots, because a recording itself cannot be read. It was produced by
someone hitting a bug on their own device, narrating as they went.

The bundle folder is named `repro-YYYY-MM-DD-HHMM` and contains:

| File | What it is |
| --- | --- |
| `README.md` | The reporter's own title and summary, plus the recording's environment |
| `transcript.md` | The narration, one timestamped line per segment |
| `transcript.json` | The same narration with exact start and end times |
| `manifest.json` | Every screenshot: its time, why it was captured, and which narration segment it belongs to |
| `frames/NNNN.png` | The screenshots, in time order |

## How to read it

Do all of this **before** proposing or writing a fix.

1. Read `README.md`. The reporter's summary is the claim to be verified, not
   the conclusion.
2. Read `transcript.md` end to end. This is what the reporter said was
   happening, in their own words.
3. Read `manifest.json`. Then walk the frames **in time order**, viewing each
   PNG next to the narration segment whose `segmentId` it carries. A frame with
   `"reason": "scene-change"` is a moment the screen visibly changed; that is
   usually where the interesting thing happened. `"segment-start"` frames show
   what was on screen as a sentence began.
4. The transcript is machine transcription of speech. Expect wrong words,
   especially product names and identifiers. When the narration and the frames
   disagree, believe the frames.

## What to produce

Write these three things out before any code:

1. **Steps to reproduce**, numbered, each step citing the frame that shows it
   (`frames/0007.png` at 12.4 s).
2. **The observed failure**: what the screen shows that should not be there,
   or what is missing, with the frame that first shows it.
3. **The first suspicious frame**: the earliest frame where the screen departs
   from what the narration expected, and what changed between it and the frame
   before it.

Then say what you would check in the code, and only then start looking.

## Things that mislead

- Frame times are when the screenshot was taken, not when the user tapped. A
  tap is usually just before the scene change that follows it.
- The frame cap means some visual changes were not captured. Gaps in
  `timeSec` larger than the surrounding ones are places where you are guessing.
- A segment with no frame of its own was spoken over an unchanged screen.
- The bundle deliberately contains no video. If the frames cannot settle a
  question, say so and ask for a recording of that moment rather than
  inventing the missing step.
