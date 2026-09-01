/**
 * The whole job, in order: open the video, look for scene changes, transcribe
 * the narration, decide which frames to keep, capture them, and write the ZIP.
 *
 * Every step reports progress through `onStage` so the UI never has to guess.
 */

import { decodeToMono16k, AudioDecodeError, NoAudioTrackError } from "./audio/decode";
import { transcribe } from "./audio/transcribe";
import { attachSegmentIds, planFrames } from "./bundle/align";
import {
  buildManifest,
  buildReadme,
  buildTranscriptJson,
  buildTranscriptMarkdown,
  bundleFolderName,
  frameFileName,
} from "./bundle/manifest";
import { createZip, encodeJson, encodeText, type ZipEntry } from "./bundle/zip";
import { captureFrames, openVideo, type VideoHandle } from "./video/frames";
import { detectSceneChanges } from "./video/scene-change";
import { nullLogger, type ScopedLogger } from "./log";
import { probeMp4 } from "./video/probe";
import type {
  BundleMeta,
  CapturedFrame,
  Segment,
  Settings,
  SourceInfo,
  TranscriptionInfo,
} from "./types";

export type Stage =
  | "opening"
  | "scanning"
  | "decoding-audio"
  | "transcribing"
  | "capturing"
  | "zipping"
  | "done";

export interface StageUpdate {
  stage: Stage;
  /** 0..1 within the stage, or undefined when the stage has no measurable end. */
  fraction?: number;
  detail?: string;
}

export interface RunOptions {
  file: File;
  settings: Settings;
  title: string;
  summary: string;
  signal?: AbortSignal;
  onStage: (update: StageUpdate) => void;
  /** Non-fatal problems worth telling the user about, e.g. a missing audio track. */
  onWarning?: (message: string) => void;
  /** Records what actually happened, so a failure can be reported without the file. */
  log?: ScopedLogger;
  /** The log so far, as text. Called just before the ZIP is written. */
  logText?: () => string;
}

export interface RunResult {
  blob: Blob;
  folder: string;
  fileName: string;
  frameCount: number;
  segmentCount: number;
  source: SourceInfo;
  transcription: TranscriptionInfo;
  /** Every bundle file, kept for the GitHub export path. */
  files: ZipEntry[];
}

export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  const { file, settings, signal, onStage } = opts;
  const log = opts.log ?? nullLogger;
  let handle: VideoHandle | null = null;

  const warn = (message: string) => {
    log.warn(message);
    opts.onWarning?.(message);
  };

  try {
    log.info("Run started", {
      file: { name: file.name, type: file.type || "(none)", sizeBytes: file.size },
      settings: {
        transcribe: settings.transcribe,
        model: settings.model,
        frameIntervalSec: settings.frameIntervalSec,
        frameCap: settings.frameCap,
        sceneThreshold: settings.sceneThreshold,
        maxFrameEdge: settings.maxFrameEdge,
      },
      userAgent: navigator.userAgent,
    });

    onStage({ stage: "opening" });
    try {
      const container = await probeMp4(file);
      log.info("Container", (container ?? { note: "not an ISO base media file" }) as Record<string, unknown>);
    } catch (err) {
      log.failure("Could not read the container", err);
    }

    handle = await openVideo(file);
    log.info("Video element loaded", {
      width: handle.width,
      height: handle.height,
      durationSec: Number(handle.durationSec.toFixed(3)),
    });
    const source: SourceInfo = {
      filename: file.name || "recording.mp4",
      durationSec: round3(handle.durationSec),
      width: handle.width,
      height: handle.height,
    };

    onStage({ stage: "scanning", fraction: 0 });
    const sceneChanges = await detectSceneChanges(handle, {
      threshold: settings.sceneThreshold,
      signal,
      onProgress: (fraction) => onStage({ stage: "scanning", fraction }),
      onScanFallback: (err) => {
        log.failure("Fast scan failed; falling back to seeking", err);
        onStage({ stage: "scanning", detail: "fast scan failed, seeking instead" });
      },
      onScanAbandoned: (err) =>
        warn(
          `Screen-change detection stopped early (${err.message}). Frames come from the ` +
            `narration and the fixed interval instead, so a change on a silent screen may be missing.`,
        ),
    });
    log.info("Scan complete", {
      sceneChanges: sceneChanges.length,
      times: sceneChanges.slice(0, 40).map((change) => Number(change.timeSec.toFixed(2))),
    });

    let segments: Segment[] = [];
    let transcription: TranscriptionInfo = { model: "none", device: "none" };

    if (settings.transcribe) {
      onStage({ stage: "decoding-audio" });
      try {
        const audio = await decodeToMono16k(file, signal);
        onStage({ stage: "transcribing", detail: "loading model" });
        const result = await transcribe(
          audio,
          settings.model,
          handle.durationSec,
          {
            onDevice: (device) =>
              onStage({ stage: "transcribing", detail: `running on ${device}` }),
            onDownload: (fileName, progress) =>
              onStage({
                stage: "transcribing",
                detail: `downloading model ${fileName} ${progress}%`,
                fraction: progress / 100,
              }),
            onReady: () => onStage({ stage: "transcribing", detail: "transcribing narration" }),
          },
          signal,
        );
        segments = result.segments;
        transcription = result.transcription;
        log.info("Transcribed", {
          segments: segments.length,
          model: transcription.model,
          device: transcription.device,
          firstSegment: segments[0]?.text,
        });
      } catch (err) {
        if (isAbort(err)) throw err;
        log.failure("Transcription failed", err);
        if (err instanceof NoAudioTrackError) {
          warn(err.message);
        } else if (err instanceof AudioDecodeError) {
          warn(
            `${err.message} The bundle will still contain frames, but no transcript.`,
          );
        } else {
          warn(
            `Transcription failed (${err instanceof Error ? err.message : String(err)}). ` +
              `The bundle will still contain frames, but no transcript.`,
          );
        }
      }
    }

    const plan = attachSegmentIds(
      planFrames({
        durationSec: handle.durationSec,
        segments,
        sceneChanges,
        intervalSec: settings.frameIntervalSec,
        frameCap: settings.frameCap,
      }),
      segments,
    );

    log.info("Frame plan", {
      frames: plan.length,
      reasons: plan.reduce<Record<string, number>>((counts, frame) => {
        counts[frame.reason] = (counts[frame.reason] ?? 0) + 1;
        return counts;
      }, {}),
    });

    onStage({ stage: "capturing", fraction: 0, detail: `0 / ${plan.length} frames` });
    const result = await captureFrames(
      handle,
      plan.map((frame) => frame.timeSec),
      {
        maxEdge: settings.maxFrameEdge,
        signal,
        onProgress: (done, total) =>
          onStage({
            stage: "capturing",
            fraction: total === 0 ? 1 : done / total,
            detail: `${done} / ${total} frames`,
          }),
        onFrameFailed: (timeSec, err) => log.failure("Frame could not be captured", err, { timeSec }),
      },
    );

    log.info("Frames captured", {
      planned: plan.length,
      captured: result.captured.length,
      failed: result.failed.length,
    });
    if (result.failed.length > 0) {
      warn(
        `${result.failed.length} of ${plan.length} frames could not be decoded and were left out ` +
          `of the bundle. The rest are here, in order.`,
      );
    }
    if (result.captured.length === 0) {
      throw new Error("No frames could be captured from this recording.");
    }

    const captured: CapturedFrame[] = result.captured.map(({ index, bytes }) => ({
      ...plan[index]!,
      bytes,
    }));

    const folder = bundleFolderName();
    const meta: BundleMeta = {
      title: opts.title,
      summary: opts.summary,
      folder,
      userAgent: navigator.userAgent,
    };

    const files = buildBundleFiles({
      folder,
      debugLog: settings.includeDebugLog ? opts.logText?.() : undefined,
      meta,
      source,
      transcription,
      segments,
      captured,
      includeUserAgent: settings.includeUserAgent,
    });

    onStage({ stage: "zipping", fraction: 0 });
    const blob = await createZip(files, {
      signal,
      onProgress: (written) =>
        onStage({ stage: "zipping", fraction: written / files.length }),
    });

    log.info("Bundle written", {
      folder,
      frames: captured.length,
      segments: segments.length,
      zipBytes: blob.size,
      medianFrameBytes: medianOf(captured.map((frame) => frame.bytes.length)),
    });
    onStage({ stage: "done", fraction: 1 });
    return {
      blob,
      folder,
      fileName: `${folder}.zip`,
      frameCount: captured.length,
      segmentCount: segments.length,
      source,
      transcription,
      files,
    };
  } finally {
    handle?.release();
  }
}

export interface BundleFilesInput {
  folder: string;
  meta: BundleMeta;
  source: SourceInfo;
  transcription: TranscriptionInfo;
  segments: Segment[];
  captured: CapturedFrame[];
  includeUserAgent: boolean;
  /** Optional run log, written as debug.log beside the bundle's own files. */
  debugLog?: string;
}

/** Lays out the exact file set of the bundle, in the order it is written. */
export function buildBundleFiles(input: BundleFilesInput): ZipEntry[] {
  const { folder, meta, source, transcription, segments, captured, includeUserAgent } = input;
  const manifest = buildManifest(captured);
  const entries: ZipEntry[] = [
    {
      path: `${folder}/README.md`,
      bytes: encodeText(
        buildReadme({
          meta,
          source,
          transcription,
          frameCount: captured.length,
          includeUserAgent,
        }),
      ),
    },
    {
      path: `${folder}/transcript.md`,
      bytes: encodeText(buildTranscriptMarkdown(segments)),
    },
    {
      path: `${folder}/transcript.json`,
      bytes: encodeJson(buildTranscriptJson(source, transcription, segments)),
    },
    { path: `${folder}/manifest.json`, bytes: encodeJson(manifest) },
  ];

  if (input.debugLog) {
    entries.push({ path: `${folder}/debug.log`, bytes: encodeText(input.debugLog) });
  }

  captured.forEach((frame, index) => {
    entries.push({ path: `${folder}/${frameFileName(index)}`, bytes: frame.bytes, store: true });
  });

  return entries;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
