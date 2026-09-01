/**
 * Frame capture. Runs on the main thread because <video> decoding is only
 * available there in every target browser.
 *
 * Two capture strategies live here:
 *   - `scan()`   : one fast pass over the video, sampling small frames for
 *                  scene-change detection (see scene-change.ts).
 *   - `capture()`: precise seeks for the frames the plan actually wants,
 *                  encoded as full-quality PNGs.
 */

export const MAX_EDGE_PX = 1280;

export interface VideoHandle {
  el: HTMLVideoElement;
  url: string;
  durationSec: number;
  /** Display dimensions, i.e. rotation metadata already applied by the browser. */
  width: number;
  height: number;
  release(): void;
}

export class VideoLoadError extends Error {
  constructor(message: string, readonly mediaError: MediaError | null = null) {
    super(message);
    this.name = "VideoLoadError";
  }
}

/** Loads a file into a hidden <video> and waits for metadata. */
export async function openVideo(file: File | Blob): Promise<VideoHandle> {
  const url = URL.createObjectURL(file);
  const el = document.createElement("video");
  el.preload = "auto";
  el.muted = true;
  el.playsInline = true;
  // Safari will not decode frames for a video that was never in the document.
  el.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(el);
  el.src = url;

  try {
    await waitForMetadata(el);
  } catch (err) {
    const mediaError = el.error;
    el.remove();
    URL.revokeObjectURL(url);
    // The caller pairs this with video/diagnose.ts, which can say which codec
    // the file actually uses; on its own, `media error 4` tells nobody anything.
    throw new VideoLoadError(`Could not read this file as video (${(err as Error).message}).`, mediaError);
  }

  // Some iOS recordings report duration Infinity until a seek forces the
  // demuxer to scan to the end.
  let durationSec = el.duration;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    durationSec = await probeDuration(el);
  }

  return {
    el,
    url,
    durationSec,
    width: el.videoWidth,
    height: el.videoHeight,
    release() {
      el.pause();
      el.removeAttribute("src");
      el.load();
      el.remove();
      URL.revokeObjectURL(url);
    },
  };
}

function waitForMetadata(el: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(el.error ? `media error ${el.error.code}` : "no metadata"));
    };
    const cleanup = () => {
      el.removeEventListener("loadedmetadata", done);
      el.removeEventListener("error", fail);
    };
    el.addEventListener("loadedmetadata", done, { once: true });
    el.addEventListener("error", fail, { once: true });
  });
}

async function probeDuration(el: HTMLVideoElement): Promise<number> {
  const seekTo = 1e6;
  await new Promise<void>((resolve) => {
    const onSeek = () => resolve();
    el.addEventListener("seeked", onSeek, { once: true });
    el.addEventListener("timeupdate", onSeek, { once: true });
    el.currentTime = seekTo;
    setTimeout(resolve, 3000);
  });
  const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : el.currentTime;
  el.currentTime = 0;
  return d;
}

/**
 * Scales so the longest edge is at most MAX_EDGE_PX. Never upscales.
 */
export function fitSize(
  width: number,
  height: number,
  maxEdge = MAX_EDGE_PX,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Seeks and resolves once the frame at (or just after) `t` is displayable. */
export function seek(el: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = Math.max(0, t);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("error", onError);
      resolve();
    };
    const onSeeked = () => {
      // rVFC guarantees a painted frame; without it, `seeked` is the best signal.
      const rvfc = (el as VideoWithRvfc).requestVideoFrameCallback;
      if (typeof rvfc === "function") rvfc.call(el, () => finish());
      else finish();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("seek failed"));
    };
    // Guard against browsers that silently drop a seek near the end of file.
    const timer = setTimeout(finish, 3000);
    el.addEventListener("seeked", onSeeked, { once: true });
    el.addEventListener("error", onError, { once: true });
    el.currentTime = target;
  });
}

type FrameCallback = (now: number, meta: { mediaTime: number }) => void;

/** requestVideoFrameCallback is unavailable in Firefox, so it is optional here. */
type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: FrameCallback) => number;
};

export function hasVideoFrameCallback(el: HTMLVideoElement): boolean {
  return typeof (el as VideoWithRvfc).requestVideoFrameCallback === "function";
}

export function onVideoFrame(
  el: HTMLVideoElement,
  cb: (mediaTime: number) => void,
): () => void {
  const v = el as VideoWithRvfc;
  let cancelled = false;
  const step: FrameCallback = (_now, meta) => {
    if (cancelled) return;
    cb(meta.mediaTime);
    if (!cancelled) v.requestVideoFrameCallback!(step);
  };
  v.requestVideoFrameCallback!(step);
  return () => {
    cancelled = true;
  };
}

export interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export function makeCanvas(width: number, height: number, willReadFrequently = false): Canvas2D {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d", { willReadFrequently, alpha: false });
  if (!ctx) throw new Error("2D canvas is unavailable in this browser");
  return { canvas, ctx };
}

/** Encodes the canvas as PNG bytes. */
export async function toPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG encoding failed");
  return new Uint8Array(await blob.arrayBuffer());
}

export interface CaptureOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Captures one PNG per requested timestamp, in time order.
 * Returns bytes in the same order as `times`.
 */
export async function captureFrames(
  handle: VideoHandle,
  times: number[],
  opts: CaptureOptions = {},
): Promise<Uint8Array[]> {
  const { width, height } = fitSize(handle.width, handle.height);
  const { canvas, ctx } = makeCanvas(width, height);
  const out: Uint8Array[] = [];
  for (let i = 0; i < times.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    await seek(handle.el, clampTime(times[i]!, handle.durationSec));
    ctx.drawImage(handle.el, 0, 0, width, height);
    out.push(await toPngBytes(canvas));
    opts.onProgress?.(i + 1, times.length);
  }
  return out;
}

/** Keeps a requested time inside the decodable range of the file. */
export function clampTime(t: number, durationSec: number): number {
  const end = Math.max(0, durationSec - 0.05);
  return Math.min(Math.max(0, t), end);
}
