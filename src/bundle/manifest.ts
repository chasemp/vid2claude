/**
 * Builders for every text file in the bundle. All pure, so the exact bytes
 * that ship are unit tested.
 */

import {
  BUNDLE_SCHEMA,
  type BundleMeta,
  type CapturedFrame,
  type FrameEntry,
  type ManifestFile,
  type Segment,
  type SourceInfo,
  type TranscriptFile,
  type TranscriptionInfo,
} from "../types";

export function frameFileName(index: number): string {
  return `frames/${String(index + 1).padStart(4, "0")}.png`;
}

/** `[00:03.4]` — minutes:seconds with a tenth, hours prefixed when needed. */
export function formatTimestamp(totalSeconds: number): string {
  // Round to tenths first: rounding after splitting the fields would let
  // 59.98 s print as "00:60.0".
  const tenths = Math.round(Math.max(0, totalSeconds) * 10);
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const seconds = (tenths % 600) / 10;
  const secondsText = seconds.toFixed(1).padStart(4, "0");
  const core = `${String(minutes).padStart(2, "0")}:${secondsText}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${core}` : core;
}

export function buildTranscriptJson(
  source: SourceInfo,
  transcription: TranscriptionInfo,
  segments: Segment[],
): TranscriptFile {
  return { schema: BUNDLE_SCHEMA, source, transcription, segments };
}

export function buildTranscriptMarkdown(segments: Segment[]): string {
  if (segments.length === 0) {
    return "_No narration was transcribed for this recording._\n";
  }
  return segments.map((s) => `[${formatTimestamp(s.startSec)}] ${s.text}`).join("\n\n") + "\n";
}

export function buildManifest(frames: CapturedFrame[]): ManifestFile {
  const entries: FrameEntry[] = frames.map((frame, index) => {
    const entry: FrameEntry = {
      file: frameFileName(index),
      timeSec: frame.timeSec,
      reason: frame.reason,
    };
    if (frame.segmentId !== undefined) entry.segmentId = frame.segmentId;
    if (frame.diffScore !== undefined) entry.diffScore = frame.diffScore;
    return entry;
  });
  return { schema: BUNDLE_SCHEMA, frames: entries };
}

export interface ReadmeInput {
  meta: BundleMeta;
  source: SourceInfo;
  transcription: TranscriptionInfo;
  frameCount: number;
  includeUserAgent: boolean;
}

export function buildReadme(input: ReadmeInput): string {
  const { meta, source, transcription, frameCount, includeUserAgent } = input;
  const lines: string[] = [];

  lines.push(`# ${meta.title}`, "");

  if (meta.summary.trim()) {
    lines.push("## Summary", "", meta.summary.trim(), "");
  }

  lines.push(
    "## How to read this bundle",
    "",
    "`transcript.md` is what the person recording said, in order, with timestamps.",
    "`frames/` holds screenshots taken at the start of each narration segment and at each visual change on screen.",
    "`manifest.json` links every frame to its timestamp and to the narration segment it belongs to, so you can walk the recording frame by frame.",
    "",
    "## Environment",
    "",
    `- Source file: \`${source.filename}\``,
    `- Duration: ${source.durationSec.toFixed(1)} s`,
    `- Resolution: ${source.width}x${source.height}`,
    `- Frames: ${frameCount}`,
    `- Transcription model: ${transcription.model} (${transcription.device})`,
  );

  if (includeUserAgent) {
    lines.push(`- Processed on: \`${meta.userAgent}\``);
  }

  lines.push("");
  return lines.join("\n");
}

/** repro-YYYY-MM-DD-HHMM in local time. */
export function bundleFolderName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    "repro-",
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join("");
}

export function defaultTitle(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Bug reproduction, ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
