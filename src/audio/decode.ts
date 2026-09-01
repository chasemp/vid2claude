/**
 * MP4/MOV -> 16 kHz mono Float32Array, which is what the Whisper pipeline wants.
 *
 * Path: decodeAudioData (the browser's own demuxer + AAC decoder) and then an
 * OfflineAudioContext at 16 kHz to downmix and resample in one render.
 *
 * Assumption A1 (docs/spikes.md) covers whether decodeAudioData accepts an MP4
 * container on each target browser. If a browser turns out to reject it, this
 * throws AudioDecodeError with `canRetryWithDemuxer` set, which is the hook the
 * ffmpeg.wasm fallback would attach to.
 */

export const TARGET_SAMPLE_RATE = 16000;

export class AudioDecodeError extends Error {
  readonly canRetryWithDemuxer = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = "AudioDecodeError";
  }
}

type AudioCtor = typeof AudioContext;

function audioContextCtor(): AudioCtor {
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!ctor) throw new AudioDecodeError("Web Audio is not available in this browser");
  return ctor;
}

function offlineContextCtor(): typeof OfflineAudioContext {
  const w = window as unknown as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!ctor) throw new AudioDecodeError("OfflineAudioContext is not available in this browser");
  return ctor;
}

/** True when the file carries no audio track at all. */
export class NoAudioTrackError extends Error {
  constructor() {
    super("This recording has no audio track, so there is nothing to transcribe.");
    this.name = "NoAudioTrackError";
  }
}

export async function decodeToMono16k(
  file: Blob,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException("cancelled", "AbortError");

  const AudioCtx = audioContextCtor();
  const ctx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeAudioDataCompat(ctx, bytes);
  } catch (err) {
    throw new AudioDecodeError(
      "This browser could not decode the audio track of the recording.",
      { cause: err },
    );
  } finally {
    void ctx.close();
  }

  if (decoded.numberOfChannels === 0 || decoded.length === 0) throw new NoAudioTrackError();
  return resampleToMono16k(decoded, signal);
}

/** Safari historically only supports the callback form of decodeAudioData. */
function decodeAudioDataCompat(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(bytes, resolve, reject);
    if (maybePromise && typeof maybePromise.then === "function") {
      maybePromise.then(resolve, reject);
    }
  });
}

export async function resampleToMono16k(
  buffer: AudioBuffer,
  signal?: AbortSignal,
): Promise<Float32Array> {
  if (buffer.sampleRate === TARGET_SAMPLE_RATE && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice();
  }
  const Offline = offlineContextCtor();
  const frames = Math.max(1, Math.ceil((buffer.duration * TARGET_SAMPLE_RATE)));
  const offline = new Offline(1, frames, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
  return rendered.getChannelData(0).slice();
}
