/**
 * Drives spikes/spikes.ts in a real browser and writes docs/spike-results.json.
 *
 *   node scripts/make-fixture.mjs fixtures   # once
 *   npm run spikes                           # headless chromium
 *   npm run spikes -- --headed               # watch it happen
 *
 * Results from this machine only prove things about this machine's browser.
 * The device matrix in docs/spikes.md is still filled in by hand.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { validateBundle } from "./bundle-rules";
import { findChromium } from "./browser";

const FIXTURES = {
  hevc: "/tests/fixtures/hevc-aac.mp4",
  h264: "/tests/fixtures/h264-aac.mp4",
  mp4: "/fixtures/synthetic-portrait.mp4",
  webm: "/fixtures/synthetic-portrait.webm",
  rotated: "/fixtures/synthetic-rotated.mp4",
  truth: "/fixtures/synthetic-truth.json",
};

type Outcome = { name: string; status: "pass" | "fail" | "skip"; detail: unknown };

async function call(page: Page, fn: string, args: unknown[] = [], timeoutMs = 120_000): Promise<unknown> {
  return page.evaluate(
    async ([name, params, limit]) => {
      const run = (window.spikes as Record<string, (...a: unknown[]) => unknown>)[name as string];
      if (!run) throw new Error(`unknown spike ${name}`);
      const timeout = new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("spike timed out")), limit as number),
      );
      return (await Promise.race([run(...(params as unknown[])), timeout])) as unknown;
    },
    [fn, args, timeoutMs] as const,
  );
}

async function attempt(
  name: string,
  fn: () => Promise<unknown>,
  judge: (value: unknown) => "pass" | "fail" | "skip" = () => "pass",
): Promise<Outcome> {
  try {
    const detail = await fn();
    const status = judge(detail);
    console.log(`${status.toUpperCase().padEnd(4)} ${name}`);
    return { name, status, detail };
  } catch (err) {
    console.log(`FAIL ${name}: ${(err as Error).message.split("\n")[0]}`);
    return { name, status: "fail", detail: { error: (err as Error).message } };
  }
}

async function main(): Promise<void> {
  if (!existsSync("fixtures/synthetic-portrait.mp4")) {
    console.error("fixtures are missing: run `node scripts/make-fixture.mjs fixtures` first");
    process.exit(2);
  }

  const headed = process.argv.includes("--headed");
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;
  const results: Outcome[] = [];

  try {
    server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: "warn" });
    await server.listen();
    const base = `http://localhost:5199`;

    browser = await chromium.launch({
      headless: !headed,
      executablePath: findChromium(),
      args: ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-webgpu"],
    });
    const page = await browser.newPage();
    const networkErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`  page error: ${msg.text()}`);
    });
    page.on("requestfailed", (request) => {
      const text = request.failure()?.errorText ?? "";
      if (text) networkErrors.push(`${text} ${request.url()}`);
    });
    await page.goto(`${base}/spikes/index.html`);
    await page.waitForFunction(() => "spikes" in window);

    const codecs = (await call(page, "probeCodecs")) as Record<string, string>;
    console.log("codec support:", codecs);
    const mp4Playable = Boolean(codecs["video/mp4; codecs=avc1.42E01E,mp4a.40.2"]);
    const primary = mp4Playable ? FIXTURES.mp4 : FIXTURES.webm;
    if (!mp4Playable) {
      console.log("note: this browser build has no H.264/AAC; falling back to the WebM fixture");
    }
    results.push({
      name: "environment",
      status: "pass",
      detail: {
        userAgent: await page.evaluate(() => navigator.userAgent),
        codecs,
        fixtureUsed: primary,
      },
    });

    results.push(
      await attempt("A1 decodeAudioData -> 16 kHz mono", () => call(page, "a1DecodeAudio", [primary]), (value) => {
        const d = value as { samples: number; rms: number };
        return d.samples > 0 && d.rms > 0.001 ? "pass" : "fail";
      }),
    );

    results.push(
      await attempt("A2 Web Share with files", () => call(page, "a2ShareFiles"), (value) => {
        const d = value as { canShareZip: boolean };
        // Desktop headless has no share sheet; this is informational only.
        return d.canShareZip ? "pass" : "skip";
      }),
    );

    results.push(
      await attempt("A3 streaming ZIP of 40 MB", () => call(page, "a3Zip", [40, 1_000_000], 180_000), (value) => {
        const d = value as { zipBytes: number; inputBytes: number };
        return d.zipBytes >= d.inputBytes ? "pass" : "fail";
      }),
    );

    results.push(
      await attempt(
        "A4 GitHub API from a browser",
        async () => {
          const before = networkErrors.length;
          const detail = (await call(page, "a4GithubCors")) as Record<string, unknown>;
          const interception = networkErrors.slice(before).filter((e) => e.includes("ERR_CERT"));
          return interception.length > 0
            ? { ...detail, tlsInterception: interception.slice(0, 2) }
            : detail;
        },
        (value) => {
          const d = value as {
            simpleGet: { ok: boolean };
            preflightedPost: { reachedServer: boolean };
            tlsInterception?: string[];
          };
          // A sandbox that re-terminates TLS makes every cross-origin request
          // fail for reasons that have nothing to do with GitHub's CORS policy.
          if (d.tlsInterception) return "skip";
          if (d.simpleGet.ok && d.preflightedPost.reachedServer) return "pass";
          return d.simpleGet.ok ? "skip" : "fail";
        },
      ),
    );

    results.push(
      await attempt("A5 seek and capture the right frames", () => call(page, "a5Frames", [primary, FIXTURES.truth]), (value) =>
        (value as { ok: boolean }).ok ? "pass" : "fail",
      ),
    );

    if (mp4Playable) {
      results.push(
        await attempt("A5b rotation metadata applied", () => call(page, "a5Rotation", [FIXTURES.rotated, FIXTURES.truth]), (value) =>
          (value as { rotationApplied: boolean }).rotationApplied ? "pass" : "fail",
        ),
      );
    } else {
      results.push({ name: "A5b rotation metadata applied", status: "skip", detail: { reason: "no H.264 in this browser build" } });
    }

    results.push(
      await attempt("Phase 3 scene changes match the fixture", () => call(page, "sceneChanges", [primary, FIXTURES.truth], 180_000), (value) =>
        (value as { ok: boolean }).ok ? "pass" : "fail",
      ),
    );

    // A browser that cannot decode a file must say which codec it is, not
    // "media error 4". This browser refuses H.264 and HEVC alike, so both
    // paths are exercised for real.
    results.push(
      await attempt(
        "Diagnosis names HEVC when the browser refuses it",
        () => call(page, "diagnoseFixture", [FIXTURES.hevc]),
        (value) => {
          const d = value as { opened: boolean; summary?: string; details?: Record<string, unknown> };
          if (d.opened) return "skip";
          return d.summary?.includes("HEVC") ? "pass" : "fail";
        },
      ),
    );

    results.push(
      await attempt(
        "Diagnosis names H.264 when the browser refuses it",
        () => call(page, "diagnoseFixture", [FIXTURES.h264]),
        (value) => {
          const d = value as { opened: boolean; summary?: string };
          if (d.opened) return "skip";
          return d.summary?.includes("H.264") ? "pass" : "fail";
        },
      ),
    );

    // The log has to stand in for a file nobody can send. These check that it
    // carries the codec, the browser's decoding support and the failure, on a
    // file this browser plays and on one it refuses.
    results.push(
      await attempt(
        "Analyse reports a playable recording",
        () => call(page, "analyze", [primary], 300_000),
        (value) => {
          const d = value as { report: { verdict: string; seeks: { ok: boolean }[] }; logText: string };
          const seeksOk = d.report.seeks.length > 0 && d.report.seeks.every((s) => s.ok);
          return seeksOk && d.logText.includes("Verdict") ? "pass" : "fail";
        },
      ),
    );

    results.push(
      await attempt(
        "Analyse explains a refused recording without the file",
        () => call(page, "analyze", [FIXTURES.hevc], 300_000),
        (value) => {
          const d = value as { report: { verdict: string; container: unknown }; logText: string };
          const namesCodec = d.logText.includes("hvc1");
          const namesSupport = d.logText.includes("canPlay") || d.logText.includes("hevc");
          return namesCodec && namesSupport && d.report.verdict.includes("HEVC") ? "pass" : "fail";
        },
      ),
    );

    results.push(
      await attempt(
        "Phase 3 scene changes without requestVideoFrameCallback",
        () => call(page, "sceneChanges", [primary, FIXTURES.truth, true], 300_000),
        (value) => ((value as { ok: boolean }).ok ? "pass" : "fail"),
      ),
    );

    // A real phone recording, when one has been dropped into fixtures/: real
    // resolution, real variable frame rate, real length. The synthetic fixture
    // is regular in every way a real recording is not.
    if (existsSync("fixtures/real-android.webm")) {
      results.push(
        await attempt(
          "Real Android recording end to end",
          async () => {
            const run = (await call(
              page,
              "fullRun",
              ["/fixtures/real-android.webm", { transcribe: false }],
              600_000,
            )) as { zipBase64: string; [key: string]: unknown };
            const { zipBase64, ...rest } = run;
            writeFileSync("fixtures/real-bundle.zip", Buffer.from(zipBase64, "base64"));
            return { ...rest, validation: validateBundle({ files: unzipToMap(zipBase64) }) };
          },
          (value) => {
            const d = value as { validation: { errors: string[] }; warnings: string[] };
            return d.validation.errors.length === 0 ? "pass" : "fail";
          },
        ),
      );
    }

    results.push(
      await attempt(
        "Phase 1 full run produces a valid bundle",
        async () => {
          const run = (await call(page, "fullRun", [primary, { transcribe: false }], 240_000)) as {
            zipBase64: string;
            [key: string]: unknown;
          };
          const { zipBase64, ...rest } = run;
          // Kept on disk so the validator CLI can be exercised against a real
          // archive, not only against the in-memory copy.
          writeFileSync("fixtures/spike-bundle.zip", Buffer.from(zipBase64, "base64"));
          const report = validateBundle({ files: unzipToMap(zipBase64) });
          return { ...rest, savedTo: "fixtures/spike-bundle.zip", validation: report };
        },
        (value) => ((value as { validation: { errors: string[] } }).validation.errors.length === 0 ? "pass" : "fail"),
      ),
    );

    if (process.argv.includes("--with-transcription")) {
      results.push(
        await attempt(
          "Phase 2 transcription end to end",
          async () => {
            const run = (await call(
              page,
              "fullRun",
              [primary, { transcribe: true, model: "onnx-community/whisper-tiny.en" }],
              900_000,
            )) as { zipBase64: string; [key: string]: unknown };
            const { zipBase64, ...rest } = run;
            const files = unzipToMap(zipBase64);
            const report = validateBundle({ files });
            const transcript = JSON.parse(
              new TextDecoder().decode(files.get(`${report.folder}/transcript.json`)!),
            );
            return { ...rest, validation: report, segments: transcript.segments };
          },
          (value) => {
            const d = value as { segments: unknown[]; validation: { errors: string[] } };
            return d.validation.errors.length === 0 && d.segments.length > 0 ? "pass" : "fail";
          },
        ),
      );
    } else {
      results.push({
        name: "Phase 2 transcription end to end",
        status: "skip",
        detail: { reason: "pass --with-transcription to download the model and run it" },
      });
    }
  } finally {
    await browser?.close();
    await server?.close();
  }

  mkdirSync("docs", { recursive: true });
  const payload = { ranAt: new Date().toISOString(), results };
  writeFileSync("docs/spike-results.json", JSON.stringify(payload, null, 2) + "\n");
  console.log("\nwrote docs/spike-results.json");

  const failed = results.filter((r) => r.status === "fail");
  if (failed.length > 0) process.exitCode = 1;
}

function unzipToMap(base64: string): Map<string, Uint8Array> {
  const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  const map = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(unzipSync(bytes))) map.set(name, data);
  return map;
}

void main();
