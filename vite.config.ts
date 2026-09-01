import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    // Whisper weights are fetched at runtime from the Hugging Face CDN and cached
    // by the service worker; nothing large is inlined into the bundle.
    assetsInlineLimit: 4096,
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
  server: {
    headers: {
      // Required for the multi-threaded WASM backend of onnxruntime-web.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
});
