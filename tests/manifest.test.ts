import { describe, expect, it } from "vitest";
import {
  buildManifest,
  buildReadme,
  buildTranscriptJson,
  buildTranscriptMarkdown,
  bundleFolderName,
  defaultTitle,
  formatTimestamp,
  frameFileName,
} from "../src/bundle/manifest";
import { BUNDLE_SCHEMA, type CapturedFrame, type Segment } from "../src/types";

const source = { filename: "RPReplay_Final.mp4", durationSec: 84.3, width: 1179, height: 2556 };
const transcription = { model: "onnx-community/whisper-small.en", device: "webgpu" };
const segments: Segment[] = [
  { id: 1, startSec: 0, endSec: 3.4, text: "So I open the settings screen." },
  { id: 2, startSec: 3.4, endSec: 7, text: "And I tap save." },
];

describe("formatTimestamp", () => {
  it("formats minutes and tenths", () => {
    expect(formatTimestamp(3.44)).toBe("00:03.4");
    expect(formatTimestamp(0)).toBe("00:00.0");
    expect(formatTimestamp(75.25)).toBe("01:15.3");
  });

  it("adds an hours field only when needed", () => {
    expect(formatTimestamp(3671.5)).toBe("01:01:11.5");
  });

  it("carries a rounded 60th second into the next minute", () => {
    expect(formatTimestamp(59.98)).toBe("01:00.0");
    expect(formatTimestamp(3599.99)).toBe("01:00:00.0");
  });
});

describe("frameFileName", () => {
  it("pads to four digits from 0001", () => {
    expect(frameFileName(0)).toBe("frames/0001.png");
    expect(frameFileName(41)).toBe("frames/0042.png");
  });
});

describe("buildTranscriptMarkdown", () => {
  it("writes one timestamped line per segment, blank line separated", () => {
    expect(buildTranscriptMarkdown(segments)).toBe(
      "[00:00.0] So I open the settings screen.\n\n[00:03.4] And I tap save.\n",
    );
  });

  it("says so when there is no narration", () => {
    expect(buildTranscriptMarkdown([])).toContain("No narration");
  });
});

describe("buildManifest", () => {
  it("numbers frames in order and keeps the optional fields optional", () => {
    const frames: CapturedFrame[] = [
      { timeSec: 0, reason: "segment-start", segmentId: 1, bytes: new Uint8Array() },
      { timeSec: 2.1, reason: "scene-change", segmentId: 1, diffScore: 0.31, bytes: new Uint8Array() },
      { timeSec: 84.3, reason: "final", bytes: new Uint8Array() },
    ];
    const manifest = buildManifest(frames);
    expect(manifest.schema).toBe(BUNDLE_SCHEMA);
    expect(manifest.frames[0]).toEqual({ file: "frames/0001.png", timeSec: 0, reason: "segment-start", segmentId: 1 });
    expect(manifest.frames[1]!.diffScore).toBe(0.31);
    expect(manifest.frames[2]).toEqual({ file: "frames/0003.png", timeSec: 84.3, reason: "final" });
  });
});

describe("buildTranscriptJson", () => {
  it("matches the documented shape", () => {
    const transcript = buildTranscriptJson(source, transcription, segments);
    expect(transcript).toEqual({ schema: BUNDLE_SCHEMA, source, transcription, segments });
  });
});

describe("buildReadme", () => {
  const readme = (includeUserAgent: boolean, summary = "Save bounced me to login.") =>
    buildReadme({
      meta: { title: "Save button logs me out", summary, folder: "repro-2026-08-31-1412", userAgent: "TestAgent/1.0" },
      source,
      transcription,
      frameCount: 37,
      includeUserAgent,
    });

  it("puts the sections in the documented order", () => {
    const text = readme(true);
    expect(text.indexOf("# Save button logs me out")).toBe(0);
    expect(text.indexOf("## Summary")).toBeLessThan(text.indexOf("## How to read this bundle"));
    expect(text.indexOf("## How to read this bundle")).toBeLessThan(text.indexOf("## Environment"));
  });

  it("names every file a reader needs", () => {
    const text = readme(true);
    expect(text).toContain("transcript.md");
    expect(text).toContain("frames/");
    expect(text).toContain("manifest.json");
  });

  it("reports the environment", () => {
    const text = readme(true);
    expect(text).toContain("RPReplay_Final.mp4");
    expect(text).toContain("84.3 s");
    expect(text).toContain("1179x2556");
    expect(text).toContain("Frames: 37");
    expect(text).toContain("onnx-community/whisper-small.en (webgpu)");
    expect(text).toContain("TestAgent/1.0");
  });

  it("leaves the user agent out when the user asked it to", () => {
    expect(readme(false)).not.toContain("TestAgent/1.0");
  });

  it("skips the summary section when the user wrote nothing", () => {
    expect(readme(true, "   ")).not.toContain("## Summary");
  });
});

describe("bundleFolderName", () => {
  it("uses local time in repro-YYYY-MM-DD-HHMM form", () => {
    expect(bundleFolderName(new Date(2026, 7, 31, 14, 12))).toBe("repro-2026-08-31-1412");
    expect(bundleFolderName(new Date(2026, 0, 2, 3, 4))).toBe("repro-2026-01-02-0304");
  });
});

describe("defaultTitle", () => {
  it("names the day", () => {
    expect(defaultTitle(new Date(2026, 7, 31, 14, 12))).toBe("Bug reproduction, 2026-08-31");
  });
});
