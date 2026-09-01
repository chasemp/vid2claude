/**
 * Scene-change detection.
 *
 * Samples the video at SAMPLE_FPS at a small width, computes the mean absolute
 * pixel difference against the previous sample, and emits a timestamp whenever
 * the score crosses the threshold and enough time has passed since the last
 * emitted change.
 *
 * Two scan strategies: fast playback + requestVideoFrameCallback where
 * available (one linear decode pass), and seek-per-sample everywhere else.
 */

import type { SceneChange } from "../types";
import {
  fitSize,
  hasVideoFrameCallback,
  makeCanvas,
  onVideoFrame,
  seek,
  clampTime,
  type VideoHandle,
} from "./frames";

export const SAMPLE_FPS = 4;
export const SAMPLE_WIDTH = 160;
export const MIN_GAP_SEC = 0.75;
export const DEFAULT_THRESHOLD = 0.15;
/** Muted fast-forward rate for the scan pass. Browsers cap around 16x. */
export const SCAN_RATE = 8;
/** How long the scan waits for the next decoded frame before giving up. */
export const STALL_TIMEOUT_MS = 10_000;

/**
 * Mean absolute difference between two RGBA buffers, normalised to 0..1.
 * Alpha is ignored: the canvas is opaque, so alpha carries no signal.
 */
export function meanAbsDiff(a: Uint8ClampedArray | Uint8Array, b: Uint8ClampedArray | Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
    count += 3;
  }
  return count === 0 ? 0 : sum / count / 255;
}

export interface ChangeDetectorOptions {
  threshold?: number;
  minGapSec?: number;
}

/**
 * Stateful reducer over (time, score) samples. Kept separate from any DOM so
 * the emit rule can be unit tested.
 */
export class ChangeDetector {
  private readonly threshold: number;
  private readonly minGapSec: number;
  private lastEmitted = -Infinity;
  readonly changes: SceneChange[] = [];

  constructor(opts: ChangeDetectorOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this.minGapSec = opts.minGapSec ?? MIN_GAP_SEC;
  }

  push(timeSec: number, diffScore: number): SceneChange | null {
    if (diffScore < this.threshold) return null;
    if (timeSec - this.lastEmitted < this.minGapSec) return null;
    this.lastEmitted = timeSec;
    const change: SceneChange = { timeSec, diffScore };
    this.changes.push(change);
    return change;
  }
}

export interface ScanOptions {
  threshold?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * Runs a full scan and returns detected changes in time order.
 */
export async function detectSceneChanges(
  handle: VideoHandle,
  opts: ScanOptions = {},
): Promise<SceneChange[]> {
  const detector = new ChangeDetector({ threshold: opts.threshold });
  const size = fitSize(handle.width, handle.height, SAMPLE_WIDTH);
  const { canvas, ctx } = makeCanvas(size.width, size.height, true);
  let previous: Uint8ClampedArray | null = null;
  let lastSampled = -Infinity;

  const sample = (timeSec: number) => {
    if (timeSec - lastSampled < 1 / SAMPLE_FPS - 1e-3) return;
    lastSampled = timeSec;
    ctx.drawImage(handle.el, 0, 0, size.width, size.height);
    const data = ctx.getImageData(0, 0, size.width, size.height).data;
    if (previous) detector.push(timeSec, meanAbsDiff(previous, data));
    previous = data;
    opts.onProgress?.(handle.durationSec > 0 ? timeSec / handle.durationSec : 0);
  };

  if (hasVideoFrameCallback(handle.el)) {
    try {
      await scanByPlayback(handle, sample, opts.signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // Autoplay policy can refuse play() even on a muted element. Seeking is
      // slower but needs no playback permission.
      await scanBySeeking(handle, sample, opts.signal);
    }
  } else {
    await scanBySeeking(handle, sample, opts.signal);
  }
  opts.onProgress?.(1);
  return detector.changes;
}

async function scanByPlayback(
  handle: VideoHandle,
  sample: (t: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const el = handle.el;
  await seek(el, 0);
  el.muted = true;
  el.playbackRate = SCAN_RATE;
  let lastFrameAt = Date.now();
  const stop = onVideoFrame(el, (t) => {
    lastFrameAt = Date.now();
    sample(t);
  });
  try {
    await el.play();
    await new Promise<void>((resolve, reject) => {
      // A stalled decoder would otherwise leave the run waiting forever, so
      // give up on the fast path and keep whatever was detected so far.
      const watchdog = setInterval(() => {
        if (Date.now() - lastFrameAt > STALL_TIMEOUT_MS) {
          cleanup();
          resolve();
        }
      }, 1000);
      const onEnd = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("cancelled", "AbortError"));
      };
      const cleanup = () => {
        clearInterval(watchdog);
        el.removeEventListener("ended", onEnd);
        el.removeEventListener("error", onEnd);
        signal?.removeEventListener("abort", onAbort);
      };
      el.addEventListener("ended", onEnd, { once: true });
      el.addEventListener("error", onEnd, { once: true });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    stop();
    el.pause();
    el.playbackRate = 1;
  }
}

async function scanBySeeking(
  handle: VideoHandle,
  sample: (t: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const step = 1 / SAMPLE_FPS;
  for (let t = 0; t < handle.durationSec; t += step) {
    if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
    await seek(handle.el, clampTime(t, handle.durationSec));
    sample(t);
  }
}
