/**
 * Main-thread client for the transcription worker.
 */

import type { ModelId, Segment, TranscriptionInfo } from "../types";
import { normalizeSegments } from "./segments";
import type { WorkerRequest, WorkerResponse } from "./worker";

export interface TranscribeEvents {
  onDevice?: (device: "webgpu" | "wasm") => void;
  onDownload?: (file: string, progress: number) => void;
  onReady?: () => void;
}

export interface TranscribeResult {
  segments: Segment[];
  transcription: TranscriptionInfo;
}

let worker: Worker | null = null;

/** One worker per session: the model stays resident between runs. */
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

export function disposeWorker(): void {
  worker?.terminate();
  worker = null;
}

export function transcribe(
  audio: Float32Array,
  model: ModelId,
  durationSec: number,
  events: TranscribeEvents = {},
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      switch (msg.type) {
        case "device":
          events.onDevice?.(msg.device);
          break;
        case "download":
          events.onDownload?.(msg.file, msg.progress);
          break;
        case "ready":
          events.onReady?.();
          break;
        case "done":
          cleanup();
          resolve({
            segments: normalizeSegments(msg.chunks, { durationSec }),
            transcription: { model: msg.model, device: msg.device },
          });
          break;
        case "error":
          cleanup();
          reject(new Error(msg.message));
          break;
      }
    };
    const onAbort = () => {
      cleanup();
      // The worker cannot be interrupted mid-inference; drop it so the next
      // run starts clean rather than receiving a stale result.
      disposeWorker();
      reject(new DOMException("cancelled", "AbortError"));
    };
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
    };

    w.addEventListener("message", onMessage);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const req: WorkerRequest = {
      type: "transcribe",
      audio,
      model,
      durationSec,
      assetBase: new URL("./", document.baseURI).href,
    };
    // Transfer the audio buffer: it can be tens of megabytes.
    w.postMessage(req, [audio.buffer as ArrayBuffer]);
  });
}
