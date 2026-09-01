/**
 * The bundle format is the contract with Claude Code. Everything the app
 * produces is described by these types; `scripts/validate-bundle.ts` checks a
 * produced ZIP against them.
 */

export const BUNDLE_SCHEMA = "repro-bundle/1";

export interface SourceInfo {
  filename: string;
  durationSec: number;
  width: number;
  height: number;
}

export interface TranscriptionInfo {
  /** Hugging Face model id, or "none" when the user skipped transcription. */
  model: string;
  /** "webgpu" | "wasm" | "none" */
  device: string;
}

export interface Segment {
  id: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface TranscriptFile {
  schema: typeof BUNDLE_SCHEMA;
  source: SourceInfo;
  transcription: TranscriptionInfo;
  segments: Segment[];
}

export type FrameReason = "segment-start" | "scene-change" | "interval" | "final";

export interface FrameEntry {
  file: string;
  timeSec: number;
  reason: FrameReason;
  segmentId?: number;
  diffScore?: number;
}

export interface ManifestFile {
  schema: typeof BUNDLE_SCHEMA;
  frames: FrameEntry[];
}

/** A frame the plan asked for, before it has been captured and named. */
export interface PlannedFrame {
  timeSec: number;
  reason: FrameReason;
  segmentId?: number;
  diffScore?: number;
}

/** A visual change detected by the scanner. */
export interface SceneChange {
  timeSec: number;
  diffScore: number;
}

export interface CapturedFrame {
  timeSec: number;
  reason: FrameReason;
  segmentId?: number;
  diffScore?: number;
  bytes: Uint8Array;
}

export interface BundleMeta {
  /** One-line title the user typed. */
  title: string;
  /** Free-text "what I was trying to do / what went wrong". May be empty. */
  summary: string;
  /** Folder name, e.g. repro-2026-08-31-1412 */
  folder: string;
  userAgent: string;
}

export interface Settings {
  model: ModelId;
  transcribe: boolean;
  frameIntervalSec: number;
  frameCap: number;
  sceneThreshold: number;
  includeUserAgent: boolean;
  github: GithubSettings;
}

export interface GithubSettings {
  repo: string;
  branch: string;
  basePath: string;
}

export type ModelId =
  | "onnx-community/whisper-tiny.en"
  | "onnx-community/whisper-base.en"
  | "onnx-community/whisper-small.en";

export interface ModelChoice {
  id: ModelId;
  label: string;
  approxDownload: string;
}

export const MODELS: ModelChoice[] = [
  { id: "onnx-community/whisper-tiny.en", label: "tiny.en (fastest)", approxDownload: "~40 MB" },
  { id: "onnx-community/whisper-base.en", label: "base.en", approxDownload: "~80 MB" },
  { id: "onnx-community/whisper-small.en", label: "small.en (most accurate)", approxDownload: "~250 MB" },
];

export const DEFAULT_SETTINGS: Settings = {
  model: "onnx-community/whisper-tiny.en",
  transcribe: true,
  frameIntervalSec: 2,
  frameCap: 120,
  sceneThreshold: 0.15,
  includeUserAgent: true,
  github: { repo: "", branch: "", basePath: "repro/" },
};
