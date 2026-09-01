/**
 * Phase 0 spike harness.
 *
 * Each function checks one assumption from the plan against the real modules
 * in src/, using the generated fixtures. `scripts/run-spikes.ts` drives this
 * page in a browser and writes docs/spike-results.json.
 *
 * The point is that these run against the shipping code, not a sketch, so a
 * spike that passes is evidence about the app rather than about a demo.
 */

import { decodeToMono16k } from "../src/audio/decode";
import { createZip } from "../src/bundle/zip";
import { runPipeline } from "../src/pipeline";
import { captureFrames, fitSize, openVideo } from "../src/video/frames";
import { detectSceneChanges } from "../src/video/scene-change";
import { DEFAULT_SETTINGS, type Settings } from "../src/types";

interface Truth {
  widthPx: number;
  heightPx: number;
  holdSec: number;
  durationSec: number;
  screenChangesSec: number[];
  screens: { startSec: number; label: string; color: string }[];
  narration: { startSec: number; text: string }[];
}

async function fetchFile(url: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fixture ${url} not found (${response.status})`);
  const blob = await response.blob();
  const name = url.split("/").pop() ?? "fixture";
  const type = name.endsWith(".webm") ? "video/webm" : "video/mp4";
  return new File([blob], name, { type });
}

async function fetchTruth(url: string): Promise<Truth> {
  return (await (await fetch(url)).json()) as Truth;
}

/** What this browser build can actually decode. */
export function probeCodecs(): Record<string, string> {
  const probe = document.createElement("video");
  return {
    "video/mp4; codecs=avc1.42E01E,mp4a.40.2": probe.canPlayType('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
    "video/mp4": probe.canPlayType("video/mp4"),
    "video/quicktime": probe.canPlayType("video/quicktime"),
    "video/webm; codecs=vp8,opus": probe.canPlayType('video/webm; codecs="vp8,opus"'),
    webgpu: "gpu" in navigator ? "available" : "",
    webCodecs: "VideoDecoder" in self ? "available" : "",
  };
}

/** A1: does decodeAudioData accept this container, and is the result usable? */
export async function a1DecodeAudio(url: string): Promise<unknown> {
  const file = await fetchFile(url);
  const started = performance.now();
  const audio = await decodeToMono16k(file);
  let peak = 0;
  let energy = 0;
  for (const sample of audio) {
    peak = Math.max(peak, Math.abs(sample));
    energy += sample * sample;
  }
  return {
    ok: true,
    fixture: file.name,
    samples: audio.length,
    sampleRate: 16000,
    durationSec: Number((audio.length / 16000).toFixed(3)),
    peakAmplitude: Number(peak.toFixed(4)),
    rms: Number(Math.sqrt(energy / audio.length).toFixed(4)),
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** A2: can this browser share a ZIP as a file? Reported, not asserted. */
export async function a2ShareFiles(): Promise<unknown> {
  const file = new File([new Uint8Array([1, 2, 3])], "test.zip", { type: "application/zip" });
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  return {
    hasShare: typeof navigator.share === "function",
    hasCanShare: typeof nav.canShare === "function",
    canShareZip: typeof nav.canShare === "function" ? nav.canShare({ files: [file] }) : false,
  };
}

/** A3: stream a large archive without exhausting memory. */
export async function a3Zip(entryCount = 40, entryBytes = 1_000_000): Promise<unknown> {
  const memory = () =>
    (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
  const before = memory();
  let peak = before;
  const started = performance.now();

  // PNG-like incompressible payloads, generated one at a time so the source
  // data is never all resident either.
  function* entries() {
    for (let i = 0; i < entryCount; i++) {
      const bytes = new Uint8Array(entryBytes);
      for (let j = 0; j < entryBytes; j += 977) bytes[j] = (i * 31 + j) & 0xff;
      peak = Math.max(peak, memory());
      yield { path: `repro/frames/${String(i + 1).padStart(4, "0")}.png`, bytes, store: true };
    }
  }

  const blob = await createZip(entries());
  return {
    ok: true,
    entryCount,
    inputBytes: entryCount * entryBytes,
    zipBytes: blob.size,
    elapsedMs: Math.round(performance.now() - started),
    heapBeforeBytes: before,
    heapPeakBytes: Math.max(peak, memory()),
    heapMeasured: before > 0,
  };
}

/** A4: does a browser fetch to api.github.com survive CORS? */
export async function a4GithubCors(): Promise<unknown> {
  const result: Record<string, unknown> = { origin: location.origin };
  try {
    const response = await fetch("https://api.github.com/repos/chasemp/vid2claude", {
      headers: { Accept: "application/vnd.github+json" },
    });
    result.simpleGet = { ok: response.ok, status: response.status };
  } catch (err) {
    result.simpleGet = { ok: false, error: String(err) };
  }
  try {
    // An Authorization header forces a preflight; an invalid token still proves
    // the preflight itself was allowed (the response would be 401, not a
    // network error).
    const response = await fetch("https://api.github.com/repos/chasemp/vid2claude/git/blobs", {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer invalid-token-for-preflight-check",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ content: "aGk=", encoding: "base64" }),
    });
    result.preflightedPost = { reachedServer: true, status: response.status };
  } catch (err) {
    result.preflightedPost = { reachedServer: false, error: String(err) };
  }
  return result;
}

/** A5: are seeked frames the frames we asked for, and is rotation applied? */
export async function a5Frames(url: string, truthUrl: string): Promise<unknown> {
  const [file, truth] = await Promise.all([fetchFile(url), fetchTruth(truthUrl)]);
  const handle = await openVideo(file);
  try {
    const expected = fitSize(handle.width, handle.height);
    // Sample the middle of each screen, above the burnt-in label.
    const times = truth.screens.map((screen) => screen.startSec + truth.holdSec / 2);
    const pngs = await captureFrames(handle, times);
    const observed: { timeSec: number; expected: string; observed: string; matches: boolean }[] = [];

    for (let i = 0; i < pngs.length; i++) {
      const bitmap = await createImageBitmap(new Blob([pngs[i]! as BlobPart], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const pixel = ctx.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height * 0.2), 1, 1).data;
      const expectedHex = truth.screens[i]!.color.replace("0x", "");
      const observedHex = [pixel[0]!, pixel[1]!, pixel[2]!]
        .map((c) => c.toString(16).padStart(2, "0"))
        .join("");
      // Lossy video shifts colours by a few levels, so the check is which of
      // the known screens this frame is closest to, not an exact colour match.
      const nearest = truth.screens
        .map((screen) => ({
          label: screen.color.replace("0x", ""),
          distance: colorDistance(screen.color.replace("0x", ""), observedHex),
        }))
        .sort((a, b) => a.distance - b.distance)[0]!;
      observed.push({
        timeSec: times[i]!,
        expected: expectedHex,
        observed: observedHex,
        matches: nearest.label === expectedHex,
      });
      bitmap.close();
    }

    return {
      ok: observed.every((o) => o.matches),
      fixture: file.name,
      reportedSize: { width: handle.width, height: handle.height },
      durationSec: Number(handle.durationSec.toFixed(3)),
      expectedDurationSec: truth.durationSec,
      frameSize: expected,
      frames: observed,
    };
  } finally {
    handle.release();
  }
}

/** A5b: a file carrying a 90 degree display matrix should report upright. */
export async function a5Rotation(url: string, truthUrl: string): Promise<unknown> {
  const [file, truth] = await Promise.all([fetchFile(url), fetchTruth(truthUrl)]);
  const handle = await openVideo(file);
  try {
    return {
      fixture: file.name,
      codedSize: { width: truth.widthPx, height: truth.heightPx },
      reportedSize: { width: handle.width, height: handle.height },
      rotationApplied: handle.width === truth.heightPx && handle.height === truth.widthPx,
    };
  } finally {
    handle.release();
  }
}

/**
 * Scene detection against the known screen transitions.
 *
 * `disableRvfc` removes requestVideoFrameCallback for the duration of the run,
 * which is how Firefox sees the world: the scan then has to seek its way
 * through the file instead of fast-forwarding through it.
 */
export async function sceneChanges(url: string, truthUrl: string, disableRvfc = false): Promise<unknown> {
  const [file, truth] = await Promise.all([fetchFile(url), fetchTruth(truthUrl)]);
  const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
  const savedRvfc = proto.requestVideoFrameCallback;
  if (disableRvfc) delete proto.requestVideoFrameCallback;
  const handle = await openVideo(file);
  try {
    const started = performance.now();
    const changes = await detectSceneChanges(handle, { threshold: DEFAULT_SETTINGS.sceneThreshold });
    const matched = truth.screenChangesSec.map((expected) => {
      const nearest = changes.reduce(
        (best, change) =>
          Math.abs(change.timeSec - expected) < Math.abs(best - expected) ? change.timeSec : best,
        Number.POSITIVE_INFINITY,
      );
      return { expected, nearest, deltaSec: Number(Math.abs(nearest - expected).toFixed(3)) };
    });
    return {
      ok: matched.every((m) => m.deltaSec <= 0.5),
      strategy: disableRvfc ? "seek" : "playback",
      elapsedMs: Math.round(performance.now() - started),
      detected: changes.map((c) => ({ timeSec: Number(c.timeSec.toFixed(3)), diffScore: Number(c.diffScore.toFixed(3)) })),
      matched,
    };
  } finally {
    handle.release();
    if (disableRvfc && savedRvfc) proto.requestVideoFrameCallback = savedRvfc;
  }
}

/** A whole run, returned as base64 so the node side can validate the ZIP. */
export async function fullRun(url: string, overrides: Partial<Settings> = {}): Promise<unknown> {
  const file = await fetchFile(url);
  const settings: Settings = { ...DEFAULT_SETTINGS, transcribe: false, ...overrides };
  const stages: string[] = [];
  const warnings: string[] = [];
  const started = performance.now();
  const result = await runPipeline({
    file,
    settings,
    title: "Spike run",
    summary: "Generated by the spike harness.",
    onStage: (update) => {
      const label = update.detail ? `${update.stage}: ${update.detail}` : update.stage;
      if (stages[stages.length - 1] !== label) stages.push(label);
    },
    onWarning: (message) => warnings.push(message),
  });

  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  return {
    ok: true,
    elapsedMs: Math.round(performance.now() - started),
    folder: result.folder,
    frameCount: result.frameCount,
    segmentCount: result.segmentCount,
    zipBytes: result.blob.size,
    transcription: result.transcription,
    source: result.source,
    warnings,
    stages,
    zipBase64: toBase64(bytes),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

function colorDistance(a: string, b: string): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const ca = parseInt(a.slice(i * 2, i * 2 + 2), 16);
    const cb = parseInt(b.slice(i * 2, i * 2 + 2), 16);
    sum += (ca - cb) ** 2;
  }
  return Math.sqrt(sum);
}

declare global {
  interface Window {
    spikes: Record<string, (...args: never[]) => unknown>;
  }
}

window.spikes = {
  probeCodecs,
  a1DecodeAudio,
  a2ShareFiles,
  a3Zip,
  a4GithubCors,
  a5Frames,
  a5Rotation,
  sceneChanges,
  fullRun,
} as unknown as Window["spikes"];
