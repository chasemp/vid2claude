/**
 * Transcription worker. Keeps model download and inference off the main
 * thread so the progress UI keeps painting on a phone.
 */

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

/** The pipeline() overload set is large enough to blow up type inference here,
 *  so this narrows it to the one task this worker ever asks for. */
type PipelineFactory = (
  task: "automatic-speech-recognition",
  model: string,
  options: Record<string, unknown>,
) => Promise<AutomaticSpeechRecognitionPipeline>;
import type { ModelId } from "../types";
import type { RawChunk } from "./segments";

export type WorkerRequest = {
  type: "transcribe";
  audio: Float32Array;
  model: ModelId;
  durationSec: number;
  /** Absolute URL of the app's own directory, so the worker can find /ort/. */
  assetBase: string;
};

export type WorkerResponse =
  | { type: "device"; device: "webgpu" | "wasm" }
  | { type: "download"; file: string; progress: number }
  | { type: "ready" }
  | { type: "progress"; fraction: number }
  | { type: "done"; chunks: RawChunk[]; device: "webgpu" | "wasm"; model: ModelId }
  | { type: "error"; message: string };

/**
 * Weights normally come from the Hugging Face CDN. VITE_HF_HOST points the app
 * at a mirror instead, which is what the spike harness uses and what an
 * air-gapped deployment would need.
 */
const HF_HOST = import.meta.env.VITE_HF_HOST;
if (HF_HOST) env.remoteHost = HF_HOST;

/**
 * onnxruntime-web fetches its own wasm from a CDN unless told otherwise.
 * scripts/copy-ort.mjs puts those files in public/ort/ so everything the app
 * needs is served from this origin.
 */
function useLocalOnnxRuntime(assetBase: string): void {
  const wasm = env.backends.onnx.wasm as { wasmPaths?: string } | undefined;
  if (wasm) wasm.wasmPaths = new URL("ort/", assetBase).href;
}

/**
 * navigator.gpu can exist while no adapter is actually available (some Android
 * builds, some headless browsers), so ask for the adapter before committing to
 * the WebGPU backend.
 */
interface GpuLike {
  requestAdapter(): Promise<unknown>;
}

async function pickDevice(): Promise<"webgpu" | "wasm"> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  if (!gpu?.requestAdapter) return "wasm";
  try {
    return (await gpu.requestAdapter()) ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

const post = (msg: WorkerResponse, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? []);

let cached: { model: ModelId; device: "webgpu" | "wasm"; pipe: AutomaticSpeechRecognitionPipeline } | null =
  null;

async function getPipeline(model: ModelId, assetBase: string): Promise<{
  pipe: AutomaticSpeechRecognitionPipeline;
  device: "webgpu" | "wasm";
}> {
  if (cached && cached.model === model) return { pipe: cached.pipe, device: cached.device };
  useLocalOnnxRuntime(assetBase);
  const device = await pickDevice();
  post({ type: "device", device });

  const dtype =
    device === "webgpu"
      ? ({ encoder_model: "fp32", decoder_model_merged: "q4" } as const)
      : ("q8" as const);

  const pipe = await (pipeline as unknown as PipelineFactory)("automatic-speech-recognition", model, {
    device,
    dtype,
    progress_callback: (item: unknown) => {
      const p = item as { status?: string; file?: string; progress?: number };
      if (p.status === "progress" && p.file) {
        post({ type: "download", file: p.file, progress: Math.round(p.progress ?? 0) });
      }
    },
  });

  cached = { model, device, pipe };
  post({ type: "ready" });
  return { pipe, device };
}

self.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== "transcribe") return;
  try {
    const { pipe, device } = await getPipeline(msg.model, msg.assetBase);
    const output = (await pipe(msg.audio, {
      return_timestamps: true,
      // Whisper's own long-form windowing: 30 s windows with 5 s of overlap.
      chunk_length_s: 30,
      stride_length_s: 5,
    })) as { text: string; chunks?: RawChunk[] };

    const chunks: RawChunk[] =
      output.chunks && output.chunks.length > 0
        ? output.chunks
        : [{ timestamp: [0, msg.durationSec], text: output.text ?? "" }];

    post({ type: "done", chunks, device, model: msg.model });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
});
