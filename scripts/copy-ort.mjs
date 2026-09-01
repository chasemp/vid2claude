/**
 * Copies the onnxruntime-web runtime files into public/ort/.
 *
 * transformers.js otherwise fetches them from a public CDN at inference time,
 * which would break the app's two promises: that it works offline after the
 * first run, and that nothing about a recording depends on a third party.
 * Runs from `predev` and `prebuild`.
 */

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const from = "node_modules/onnxruntime-web/dist";
const to = "public/ort";

mkdirSync(to, { recursive: true });
const wanted = readdirSync(from).filter((name) => /^ort-wasm.*\.(wasm|mjs)$/.test(name));
if (wanted.length === 0) {
  console.error(`no onnxruntime-web runtime files found in ${from}`);
  process.exit(1);
}
for (const name of wanted) {
  copyFileSync(join(from, name), join(to, name));
}
console.log(`copied ${wanted.length} onnxruntime files to ${to}/`);
