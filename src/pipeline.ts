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
  let handle: VideoHandle | null = null;

  try {
    onStage({ stage: "opening" });
    handle = await openVideo(file);
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
      } catch (err) {
        if (isAbort(err)) throw err;
        if (err instanceof NoAudioTrackError) {
          opts.onWarning?.(err.message);
        } else if (err instanceof AudioDecodeError) {
          opts.onWarning?.(
            `${err.message} The bundle will still contain frames, but no transcript.`,
          );
        } else {
          opts.onWarning?.(
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

    onStage({ stage: "capturing", fraction: 0, detail: `0 / ${plan.length} frames` });
    const pngs = await captureFrames(
      handle,
      plan.map((frame) => frame.timeSec),
      {
        signal,
        onProgress: (done, total) =>
          onStage({
            stage: "capturing",
            fraction: total === 0 ? 1 : done / total,
            detail: `${done} / ${total} frames`,
          }),
      },
    );

    const captured: CapturedFrame[] = plan.map((frame, index) => ({
      ...frame,
      bytes: pngs[index]!,
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

  captured.forEach((frame, index) => {
    entries.push({ path: `${folder}/${frameFileName(index)}`, bytes: frame.bytes, store: true });
  });

  return entries;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
