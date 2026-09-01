/**
 * "Tell me about this recording" without processing it.
 *
 * A file that fails at load never reaches the pipeline, and a 61 MB recording
 * cannot be handed to anyone for inspection. This runs the checks that would
 * otherwise have to be guessed at — what the container holds, what the browser
 * will decode, whether seeking works across the whole file — and writes it all
 * to the run log, so the log can travel instead of the video.
 */

import { canPlay, diagnoseVideo, type Diagnosis } from "./diagnose";
import { probeMp4, type Mp4Probe } from "./probe";
import { clampTime, fitSize, makeCanvas, openVideo, seek, type VideoHandle } from "./frames";
import { nullLogger, type ScopedLogger } from "../log";
import { decodeToMono16k } from "../audio/decode";

export interface SeekProbe {
  timeSec: number;
  ok: boolean;
  elapsedMs: number;
  /** Mean luminance of the captured frame; 0 on a frame that never painted. */
  meanLuma?: number;
  error?: string;
}

export interface AnalysisReport {
  file: { name: string; type: string; sizeBytes: number };
  browser: { userAgent: string; canPlay: Record<string, string>; webgpu: boolean; webCodecs: boolean };
  container: Mp4Probe | null;
  element?: {
    reportedWidth: number;
    reportedHeight: number;
    durationSec: number;
    /** True when the browser applied the container's rotation for us. */
    rotationApplied?: boolean;
  };
  seeks: SeekProbe[];
  audio?: { ok: boolean; samples?: number; durationSec?: number; peak?: number; elapsedMs: number; error?: string };
  diagnosis?: Diagnosis;
  verdict: string;
}

export interface AnalyzeOptions {
  log?: ScopedLogger;
  signal?: AbortSignal;
  /** How many points across the recording to seek to. */
  seekProbes?: number;
  checkAudio?: boolean;
}

export async function analyzeFile(file: File, opts: AnalyzeOptions = {}): Promise<AnalysisReport> {
  const log = opts.log ?? nullLogger;
  const probeCount = opts.seekProbes ?? 5;

  const report: AnalysisReport = {
    file: { name: file.name, type: file.type || "(none)", sizeBytes: file.size },
    browser: {
      userAgent: navigator.userAgent,
      canPlay: {
        "video/mp4": canPlay("video/mp4"),
        "h264+aac": canPlay('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
        "h264 high": canPlay('video/mp4; codecs="avc1.640028,mp4a.40.2"'),
        hevc: canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"'),
        av1: canPlay('video/mp4; codecs="av01.0.08M.08"'),
        "webm vp8": canPlay('video/webm; codecs="vp8,opus"'),
        "webm vp9": canPlay('video/webm; codecs="vp9,opus"'),
      },
      webgpu: "gpu" in navigator,
      webCodecs: "VideoDecoder" in self,
    },
    container: null,
    seeks: [],
    verdict: "",
  };

  log.info("Analysing file", report.file);
  log.info("Browser decoding support", report.browser.canPlay);

  try {
    report.container = await probeMp4(file);
    log.info("Container", (report.container ?? { note: "not an ISO base media file" }) as Record<string, unknown>);
  } catch (err) {
    log.failure("Could not read the container", err);
  }

  let handle: VideoHandle | null = null;
  try {
    const started = performance.now();
    handle = await openVideo(file);
    log.info("Video element loaded", {
      elapsedMs: Math.round(performance.now() - started),
      width: handle.width,
      height: handle.height,
      durationSec: Number(handle.durationSec.toFixed(3)),
    });

    const containerVideo = report.container?.video;
    report.element = {
      reportedWidth: handle.width,
      reportedHeight: handle.height,
      durationSec: Number(handle.durationSec.toFixed(3)),
      // A 90 or 270 degree rotation should come back with the axes swapped.
      rotationApplied:
        containerVideo && containerVideo.rotationDeg % 180 === 90
          ? handle.width === containerVideo.height && handle.height === containerVideo.width
          : undefined,
    };
    if (report.element.rotationApplied !== undefined) {
      log.info("Rotation metadata", {
        containerRotationDeg: containerVideo?.rotationDeg,
        containerSize: containerVideo && `${containerVideo.width}x${containerVideo.height}`,
        reportedSize: `${handle.width}x${handle.height}`,
        appliedByBrowser: report.element.rotationApplied,
      });
    }

    report.seeks = await probeSeeks(handle, probeCount, log, opts.signal);
  } catch (err) {
    log.failure("Could not open the recording", err);
    report.diagnosis = await diagnoseVideo(
      file,
      (err as { mediaError?: MediaError | null }).mediaError ?? null,
      "load",
    );
    log.info("Diagnosis", { summary: report.diagnosis.summary });
  } finally {
    handle?.release();
  }

  if (opts.checkAudio !== false) {
    const started = performance.now();
    try {
      const audio = await decodeToMono16k(file, opts.signal);
      let peak = 0;
      for (const sample of audio) peak = Math.max(peak, Math.abs(sample));
      report.audio = {
        ok: true,
        samples: audio.length,
        durationSec: Number((audio.length / 16000).toFixed(3)),
        peak: Number(peak.toFixed(4)),
        elapsedMs: Math.round(performance.now() - started),
      };
      log.info("Audio decoded", report.audio);
    } catch (err) {
      report.audio = {
        ok: false,
        elapsedMs: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      };
      log.failure("Audio could not be decoded", err);
    }
  }

  report.verdict = verdictFor(report);
  log.info("Verdict", { verdict: report.verdict });
  return report;
}

/** Seeks across the whole file: failures cluster late, not at the start. */
async function probeSeeks(
  handle: VideoHandle,
  count: number,
  log: ScopedLogger,
  signal?: AbortSignal,
): Promise<SeekProbe[]> {
  const size = fitSize(handle.width, handle.height, 64);
  const { canvas, ctx } = makeCanvas(size.width, size.height, true);
  const probes: SeekProbe[] = [];

  for (let i = 0; i < count; i++) {
    if (signal?.aborted) break;
    const fraction = count === 1 ? 0 : i / (count - 1);
    const target = clampTime(handle.durationSec * fraction, handle.durationSec);
    const started = performance.now();
    try {
      await seek(handle.el, target);
      ctx.drawImage(handle.el, 0, 0, size.width, size.height);
      const pixels = ctx.getImageData(0, 0, size.width, size.height).data;
      let sum = 0;
      for (let p = 0; p < pixels.length; p += 4) {
        sum += (pixels[p]! + pixels[p + 1]! + pixels[p + 2]!) / 3;
      }
      const probe: SeekProbe = {
        timeSec: Number(target.toFixed(3)),
        ok: true,
        elapsedMs: Math.round(performance.now() - started),
        meanLuma: Number((sum / (pixels.length / 4) / 255).toFixed(4)),
      };
      probes.push(probe);
      log.debug("Seek probe", probe as unknown as Record<string, unknown>);
    } catch (err) {
      const probe: SeekProbe = {
        timeSec: Number(target.toFixed(3)),
        ok: false,
        elapsedMs: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      };
      probes.push(probe);
      log.failure("Seek probe failed", err, { timeSec: probe.timeSec });
      // A failed seek leaves the element dead; the rest would fail the same way.
      try {
        await handle.reload();
        log.info("Reopened the recording after a failed seek");
      } catch (reloadError) {
        log.failure("Could not reopen the recording", reloadError);
        break;
      }
    }
  }
  return probes;
}

function verdictFor(report: AnalysisReport): string {
  if (report.diagnosis) return report.diagnosis.summary;
  const failed = report.seeks.filter((probe) => !probe.ok);
  if (failed.length > 0) {
    return `The recording loads, but ${failed.length} of ${report.seeks.length} seek probes failed: this device's decoder gives up partway through.`;
  }
  const blank = report.seeks.filter((probe) => (probe.meanLuma ?? 0) === 0);
  if (report.seeks.length > 0 && blank.length === report.seeks.length) {
    return "The recording loads and seeks, but every captured frame came back empty.";
  }
  if (report.audio && !report.audio.ok) {
    return "Video is fine; the audio track could not be decoded, so there would be no transcript.";
  }
  if (report.seeks.length === 0) return "The recording could not be examined.";
  return "This recording looks processable: it loads, seeks across its whole length, and decodes audio.";
}
