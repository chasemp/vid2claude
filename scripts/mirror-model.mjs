/**
 * Downloads one Whisper model into a local mirror so the spike harness can run
 * transcription without the browser reaching the network. Useful on an
 * air-gapped machine or a sandbox that intercepts TLS.
 *
 *   node scripts/mirror-model.mjs onnx-community/whisper-tiny.en fixtures/hf-mirror
 *
 * Serve the mirror and point the app at it with VITE_HF_HOST.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const model = process.argv[2] ?? "onnx-community/whisper-tiny.en";
const outDir = process.argv[3] ?? "fixtures/hf-mirror";
const revision = "main";

/** The q8 (wasm) and q4/fp32 (webgpu) weights, plus the tokenizer files. */
const FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
  "onnx/encoder_model.onnx",
  "onnx/decoder_model_merged_q4.onnx",
];

for (const file of FILES) {
  const url = `https://huggingface.co/${model}/resolve/${revision}/${file}`;
  const target = join(outDir, model, "resolve", revision, file);
  if (existsSync(target)) {
    console.log(`have ${file}`);
    continue;
  }
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`failed ${file}: ${response.status}`);
    process.exitCode = 1;
    continue;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  console.log(`saved ${file} (${(bytes.length / 1024).toFixed(0)} KB)`);
}
