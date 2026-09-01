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
/**
 * Measured, not guessed. On a real 33 s Android screen recording the mean
 * absolute frame difference has a median of 0.009 and a maximum of 0.17: a
 * screen transition in a phone UI moves the average pixel far less than a
 * full-frame colour change does. 0.05 sits between that recording's 75th
 * percentile (0.043) and 90th (0.08), and picks out roughly one change every
 * four seconds. See docs/spikes.md.
 */
export const DEFAULT_THRESHOLD = 0.05;
/** Muted fast-forward rate for the scan pass. Browsers cap around 16x. */
export const SCAN_RATE = 4;
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
  /** The fast path failed; scanning continues by seeking. */
  onScanFallback?: (error: Error) => void;
  /** Both paths failed; the bundle goes on without scene-change frames. */
  onScanAbandoned?: (error: Error) => void;
  /** Every sampled difference, whether or not it crossed the threshold.
   *  Used to calibrate the threshold against real recordings. */
  onSample?: (timeSec: number, diffScore: number) => void;
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
    if (previous) {
      const score = meanAbsDiff(previous, data);
      opts.onSample?.(timeSec, score);
      detector.push(timeSec, score);
    }
    previous = data;
    opts.onProgress?.(handle.durationSec > 0 ? timeSec / handle.durationSec : 0);
  };

  if (hasVideoFrameCallback(handle.el)) {
    try {
      await scanByPlayback(handle, sample, opts.signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // Two things land here: an autoplay policy refusing play() even on a
      // muted element, and a decoder that gave up partway. Both leave the
      // element unusable, so take a fresh one before seeking through the file.
      opts.onScanFallback?.(err instanceof Error ? err : new Error(String(err)));
      previous = null;
      try {
        await handle.reload();
        await scanBySeeking(handle, sample, opts.signal);
      } catch (fallbackError) {
        if (fallbackError instanceof DOMException && fallbackError.name === "AbortError") throw fallbackError;
        // Screen-change detection is an enhancement: narration and interval
        // frames still make a usable bundle, so keep what was detected and
        // let the caller tell the user what was lost.
        opts.onScanAbandoned?.(
          fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)),
        );
        await handle.reload().catch(() => undefined);
      }
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
      // A decoder that fails partway is not a video that ended: the element is
      // dead from here on, and treating it as a clean finish means every later
      // seek fails with no explanation.
      const onError = () => {
        cleanup();
        reject(
          new Error(
            `The video decoder failed during the scan pass` +
              (el.error ? ` (media error ${el.error.code})` : ""),
          ),
        );
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("cancelled", "AbortError"));
      };
      const cleanup = () => {
        clearInterval(watchdog);
        el.removeEventListener("ended", onEnd);
        el.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      el.addEventListener("ended", onEnd, { once: true });
      el.addEventListener("error", onError, { once: true });
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
