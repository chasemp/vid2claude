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
  /**
   * Replaces the element with a fresh one on the same file.
   *
   * A media element that has hit an error keeps `error` set for good: every
   * later seek fails immediately. Recovering from a decoder failure means
   * starting a new element and a new decoder, not retrying on the old one.
   */
  reload(): Promise<void>;
  release(): void;
}

export class VideoLoadError extends Error {
  constructor(message: string, readonly mediaError: MediaError | null = null) {
    super(message);
    this.name = "VideoLoadError";
  }
}

/**
 * A seek that ended in a media error. Carries the element's state, because
 * "seek failed" on its own tells nobody anything — the same mistake the load
 * path used to make.
 */
export class VideoSeekError extends Error {
  constructor(
    message: string,
    readonly mediaError: MediaError | null,
    readonly context: { timeSec: number; readyState: number; networkState: number },
  ) {
    super(message);
    this.name = "VideoSeekError";
  }
}

/** Loads a file into a hidden <video> and waits for metadata. */
export async function openVideo(file: File | Blob): Promise<VideoHandle> {
  let url = URL.createObjectURL(file);
  let el = createElement(url);

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

  const handle: VideoHandle = {
    get el() {
      return el;
    },
    get url() {
      return url;
    },
    durationSec,
    width: el.videoWidth,
    height: el.videoHeight,
    async reload() {
      const previous = el;
      const previousUrl = url;
      url = URL.createObjectURL(file);
      el = createElement(url);
      try {
        await waitForMetadata(el);
      } catch (err) {
        const mediaError = el.error;
        el.remove();
        URL.revokeObjectURL(url);
        el = previous;
        url = previousUrl;
        throw new VideoLoadError(`Could not reopen the recording (${(err as Error).message}).`, mediaError);
      }
      previous.pause();
      previous.removeAttribute("src");
      previous.load();
      previous.remove();
      URL.revokeObjectURL(previousUrl);
    },
    release() {
      el.pause();
      el.removeAttribute("src");
      el.load();
      el.remove();
      URL.revokeObjectURL(url);
    },
  };
  return handle;
}

function createElement(url: string): HTMLVideoElement {
  const el = document.createElement("video");
  el.preload = "auto";
  el.muted = true;
  el.playsInline = true;
  // Safari will not decode frames for a video that was never in the document.
  el.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(el);
  el.src = url;
  return el;
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
      el.removeEventListener("seeked", onSeeked);
      reject(
        new VideoSeekError(
          `The video decoder failed while seeking to ${target.toFixed(2)}s` +
            (el.error ? ` (media error ${el.error.code})` : ""),
          el.error,
          { timeSec: target, readyState: el.readyState, networkState: el.networkState },
        ),
      );
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
  /** Longest edge of the encoded frame; defaults to MAX_EDGE_PX. */
  maxEdge?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Reports a frame that could not be captured even after a fresh decoder. */
  onFrameFailed?: (timeSec: number, error: Error) => void;
}

export interface CaptureResult {
  /** Successful captures, keyed back to the index in the requested times. */
  captured: { index: number; bytes: Uint8Array }[];
  /** Indexes that could not be captured. */
  failed: number[];
}

/**
 * Captures one PNG per requested timestamp, in time order.
 *
 * A phone's hardware decoder can fail partway through a long recording. One
 * dead frame is not worth losing the whole bundle over, so a failure gets a
 * fresh decoder and one retry, and a frame that still will not come back is
 * skipped and reported.
 */
export async function captureFrames(
  handle: VideoHandle,
  times: number[],
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const { width, height } = fitSize(handle.width, handle.height, opts.maxEdge ?? MAX_EDGE_PX);
  const { canvas, ctx } = makeCanvas(width, height);
  const captured: { index: number; bytes: Uint8Array }[] = [];
  const failed: number[] = [];

  for (let i = 0; i < times.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    const time = clampTime(times[i]!, handle.durationSec);
    try {
      captured.push({ index: i, bytes: await captureOne(handle, time, canvas, ctx, width, height) });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      try {
        await handle.reload();
        captured.push({ index: i, bytes: await captureOne(handle, time, canvas, ctx, width, height) });
      } catch (retryError) {
        failed.push(i);
        opts.onFrameFailed?.(time, retryError instanceof Error ? retryError : new Error(String(retryError)));
      }
    }
    opts.onProgress?.(i + 1, times.length);
  }

  return { captured, failed };
}

async function captureOne(
  handle: VideoHandle,
  timeSec: number,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<Uint8Array> {
  await seek(handle.el, timeSec);
  ctx.drawImage(handle.el, 0, 0, width, height);
  return toPngBytes(canvas);
}

/** Keeps a requested time inside the decodable range of the file. */
export function clampTime(t: number, durationSec: number): number {
  const end = Math.max(0, durationSec - 0.05);
  return Math.min(Math.max(0, t), end);
}
