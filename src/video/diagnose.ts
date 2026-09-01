/**
 * Why a browser refused a recording.
 *
 * `<video>` reports MEDIA_ERR_SRC_NOT_SUPPORTED and nothing else, which is not
 * enough for anyone to act on. This pairs what is actually inside the file
 * (probe.ts) with what this browser says it can decode, and turns the pair into
 * a sentence and, where there is one, a next step.
 */

import { probeMp4, type Mp4Probe } from "./probe";

export interface Diagnosis {
  /** One sentence naming the problem. */
  summary: string;
  /** What the user can do about it, when there is something. */
  advice?: string;
  /** Everything gathered, for a bug report. */
  details: Record<string, unknown>;
}

const HEVC_FOURCCS = new Set(["hvc1", "hev1", "dvh1", "dvhe"]);
const CODEC_NAMES: Record<string, string> = {
  avc1: "H.264",
  avc3: "H.264",
  hvc1: "HEVC (H.265)",
  hev1: "HEVC (H.265)",
  dvh1: "Dolby Vision (HEVC)",
  dvhe: "Dolby Vision (HEVC)",
  av01: "AV1",
  vp08: "VP8",
  vp09: "VP9",
  mp4v: "MPEG-4 Part 2",
};

/** What this browser claims about a set of codec strings. */
export function canPlay(mimeWithCodecs: string): string {
  const probe = document.createElement("video");
  return probe.canPlayType(mimeWithCodecs) || "no";
}

export type FailureStage = "load" | "seek";

export async function diagnoseVideo(
  file: File,
  mediaError?: MediaError | null,
  stage: FailureStage = "load",
  context?: Record<string, unknown>,
): Promise<Diagnosis> {
  const details: Record<string, unknown> = {
    stage,
    ...(context ? { context } : {}),
    fileName: file.name,
    fileType: file.type || "(none)",
    fileSizeBytes: file.size,
    mediaErrorCode: mediaError?.code,
    mediaErrorMessage: mediaError?.message || undefined,
    userAgent: navigator.userAgent,
    canPlay: {
      "video/mp4": canPlay("video/mp4"),
      "h264+aac": canPlay('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
      hevc: canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      av1: canPlay('video/mp4; codecs="av01.0.08M.08"'),
      "webm vp8": canPlay('video/webm; codecs="vp8,opus"'),
    },
  };

  let probe: Mp4Probe | null = null;
  try {
    probe = await probeMp4(file);
    details.container = probe ?? "not an MP4/MOV container";
  } catch (err) {
    details.probeError = err instanceof Error ? err.message : String(err);
  }

  if (!probe) {
    return {
      summary: "This file does not look like an MP4 or MOV recording.",
      advice:
        "Pick the recording your screen recorder saved, rather than a file that was renamed or " +
        "re-wrapped. WebM works too, if your browser can play it.",
      details,
    };
  }

  if (!probe.video) {
    return {
      summary: "This file has no video track that could be found.",
      advice: "It may still be uploading or syncing from cloud storage. Try again once it is fully downloaded.",
      details,
    };
  }

  const { fourcc, codec } = probe.video;
  const name = CODEC_NAMES[fourcc] ?? fourcc;
  const exact = codec ? canPlay(`video/mp4; codecs="${codec}"`) : "";
  details.canPlayExact = { codec, result: exact || "no" };

  if (stage === "seek") {
    // The file loaded, so the container and codec are fine; the decoder gave
    // up partway through, which on a phone usually means it ran out of room.
    return {
      summary:
        `This device's video decoder gave up partway through the recording ` +
        `(${name}, ${probe.video.width}x${probe.video.height}).`,
      advice:
        "Close other apps and try again, or use a shorter or lower-resolution recording. " +
        "The app now retries with a fresh decoder and skips any frame it still cannot read, " +
        "so a bundle usually still comes out.",
      details,
    };
  }

  if (HEVC_FOURCCS.has(fourcc)) {
    return {
      summary: `This recording is ${name}, and this browser cannot decode it on this device.`,
      advice:
        "Android and iPhone screen recorders can be set to record in H.264 instead: look for " +
        '"H.264", "More compatible", or turn off "High efficiency" / HEVC in the recorder or ' +
        "camera settings, then record again. An existing HEVC file has to be converted before " +
        "this app can read it.",
      details,
    };
  }

  if (fourcc === "av01") {
    return {
      summary: `This recording is ${name}, which this browser cannot decode on this device.`,
      advice: "Record in H.264 instead, or convert the file before bringing it here.",
      details,
    };
  }

  if (exact && exact !== "no") {
    return {
      summary:
        `This recording is ${name}, which this browser says it can play — so the file itself is ` +
        `not the obvious problem.`,
      advice:
        "If the recording is still syncing from cloud storage, wait for it to finish and try again. " +
        "Otherwise copy the diagnostics below into a bug report; they say exactly what was tried.",
      details,
    };
  }

  if (fourcc.startsWith("avc")) {
    // H.264 is the one codec every phone browser decodes, so a refusal here is
    // about the browser, not the recording.
    return {
      summary: `This recording is ${name}, but this browser has no H.264 decoder.`,
      advice:
        "That is unusual on a phone. Try the same file in Chrome or Safari; browser builds without " +
        "the licensed codecs (some Linux and privacy-focused builds) cannot play ordinary screen " +
        "recordings at all.",
      details,
    };
  }

  return {
    summary: `This recording is ${name}, which this browser will not decode on this device.`,
    advice: "Record in H.264 (sometimes called the 'more compatible' setting) and try again.",
    details,
  };
}

export function formatDiagnostics(diagnosis: Diagnosis): string {
  return JSON.stringify(diagnosis.details, null, 2);
}
