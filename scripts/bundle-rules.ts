/**
 * The rules a bundle must satisfy. Kept apart from the CLI so the unit tests
 * can run them against an in-memory bundle.
 */

import { BUNDLE_SCHEMA, type ManifestFile, type TranscriptFile } from "../src/types";

export interface BundleContents {
  /** Path relative to the bundle's parent, e.g. "repro-2026-08-31-1412/README.md". */
  files: Map<string, Uint8Array>;
}

export interface ValidationReport {
  folder: string;
  frameCount: number;
  segmentCount: number;
  errors: string[];
  warnings: string[];
}

const FOLDER_RE = /^repro-\d{4}-\d{2}-\d{2}-\d{4}$/;
const REQUIRED = ["README.md", "transcript.md", "transcript.json", "manifest.json"];
const VALID_REASONS = new Set(["segment-start", "scene-change", "interval", "final"]);
/** Section 5: frames are PNG, longest edge at most 1280 px. */
const MAX_EDGE_PX = 1280;

export function validateBundle(contents: BundleContents): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const paths = [...contents.files.keys()];

  const folders = new Set(paths.map((p) => p.split("/")[0] ?? ""));
  if (folders.size !== 1) {
    errors.push(`expected exactly one top-level folder, found ${[...folders].join(", ") || "none"}`);
    return { folder: "", frameCount: 0, segmentCount: 0, errors, warnings };
  }
  const folder = [...folders][0]!;
  if (!FOLDER_RE.test(folder)) {
    errors.push(`folder name "${folder}" is not repro-YYYY-MM-DD-HHMM`);
  }

  const read = (name: string) => contents.files.get(`${folder}/${name}`);
  for (const required of REQUIRED) {
    if (!read(required)) errors.push(`missing ${required}`);
  }

  const manifestBytes = read("manifest.json");
  const transcriptBytes = read("transcript.json");
  if (!manifestBytes || !transcriptBytes) {
    return { folder, frameCount: 0, segmentCount: 0, errors, warnings };
  }

  let manifest: ManifestFile;
  let transcript: TranscriptFile;
  try {
    manifest = JSON.parse(decode(manifestBytes)) as ManifestFile;
  } catch (err) {
    errors.push(`manifest.json is not valid JSON: ${(err as Error).message}`);
    return { folder, frameCount: 0, segmentCount: 0, errors, warnings };
  }
  try {
    transcript = JSON.parse(decode(transcriptBytes)) as TranscriptFile;
  } catch (err) {
    errors.push(`transcript.json is not valid JSON: ${(err as Error).message}`);
    return { folder, frameCount: 0, segmentCount: 0, errors, warnings };
  }

  if (manifest.schema !== BUNDLE_SCHEMA) errors.push(`manifest.json schema is "${manifest.schema}"`);
  if (transcript.schema !== BUNDLE_SCHEMA) errors.push(`transcript.json schema is "${transcript.schema}"`);

  // Frames
  const frames = manifest.frames ?? [];
  if (frames.length === 0) errors.push("manifest.json lists no frames");
  let previousTime = -Infinity;
  frames.forEach((frame, index) => {
    const where = `manifest.frames[${index}]`;
    if (!contents.files.has(`${folder}/${frame.file}`)) errors.push(`${where}: ${frame.file} is missing`);
    if (frame.file !== `frames/${String(index + 1).padStart(4, "0")}.png`) {
      errors.push(`${where}: file "${frame.file}" is out of sequence`);
    }
    if (!VALID_REASONS.has(frame.reason)) errors.push(`${where}: unknown reason "${frame.reason}"`);
    if (!Number.isFinite(frame.timeSec) || frame.timeSec < 0) {
      errors.push(`${where}: timeSec ${frame.timeSec} is not a time`);
    }
    if (frame.timeSec < previousTime) {
      errors.push(`${where}: timeSec ${frame.timeSec} goes backwards from ${previousTime}`);
    }
    previousTime = frame.timeSec;
    if (frame.timeSec > transcript.source.durationSec + 0.5) {
      errors.push(`${where}: timeSec ${frame.timeSec} is past the end of the recording`);
    }
    const bytes = contents.files.get(`${folder}/${frame.file}`);
    if (bytes) {
      const size = pngSize(bytes);
      if (!size) errors.push(`${where}: ${frame.file} is not a PNG`);
      else if (Math.max(size.width, size.height) > MAX_EDGE_PX) {
        errors.push(`${where}: ${frame.file} is ${size.width}x${size.height}, longest edge over ${MAX_EDGE_PX}`);
      }
    }
  });

  // Every PNG in the folder must be listed.
  const listed = new Set(frames.map((f) => `${folder}/${f.file}`));
  for (const path of paths) {
    if (path.endsWith(".png") && !listed.has(path)) errors.push(`${path} is not listed in manifest.json`);
  }

  // Segments
  const segments = transcript.segments ?? [];
  let previousStart = -Infinity;
  segments.forEach((segment, index) => {
    const where = `transcript.segments[${index}]`;
    if (segment.id !== index + 1) errors.push(`${where}: id ${segment.id} should be ${index + 1}`);
    if (segment.startSec < previousStart) {
      errors.push(`${where}: startSec ${segment.startSec} goes backwards from ${previousStart}`);
    }
    if (segment.endSec < segment.startSec) {
      errors.push(`${where}: endSec ${segment.endSec} is before startSec ${segment.startSec}`);
    }
    if (segment.startSec > transcript.source.durationSec + 0.5) {
      errors.push(`${where}: startSec ${segment.startSec} is past the end of the recording`);
    }
    if (!segment.text.trim()) errors.push(`${where}: empty text`);
    previousStart = segment.startSec;
  });

  const covered = new Set(frames.map((f) => f.segmentId).filter((id): id is number => id !== undefined));
  const uncovered = segments.filter((s) => !covered.has(s.id));
  if (uncovered.length > 0) {
    warnings.push(
      `${uncovered.length} segment(s) have no frame of their own: ${uncovered
        .slice(0, 5)
        .map((s) => s.id)
        .join(", ")}`,
    );
  }

  // transcript.md must line up with the JSON.
  const markdown = read("transcript.md");
  if (markdown) {
    const lines = decode(markdown).split("\n").filter((line) => line.trim().startsWith("["));
    if (lines.length !== segments.length) {
      errors.push(`transcript.md has ${lines.length} timestamped lines but transcript.json has ${segments.length} segments`);
    }
  }

  return { folder, frameCount: frames.length, segmentCount: segments.length, errors, warnings };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Reads width/height out of a PNG IHDR without decoding the image. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < signature.length; i++) if (bytes[i] !== signature[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
