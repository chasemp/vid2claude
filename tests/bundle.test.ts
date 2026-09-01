import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { buildBundleFiles } from "../src/pipeline";
import { createZip } from "../src/bundle/zip";
import { validateBundle, pngSize, type BundleContents } from "../scripts/bundle-rules";
import type { CapturedFrame, Segment } from "../src/types";
import { makePng } from "./helpers/png";

const segments: Segment[] = [
  { id: 1, startSec: 0, endSec: 3.4, text: "So I open the settings screen." },
  { id: 2, startSec: 3.4, endSec: 7, text: "And I tap save." },
];

const captured: CapturedFrame[] = [
  { timeSec: 0, reason: "segment-start", segmentId: 1, bytes: makePng(64, 128, [10, 10, 10]) },
  { timeSec: 2.1, reason: "scene-change", segmentId: 1, diffScore: 0.31, bytes: makePng(64, 128, [200, 10, 10]) },
  { timeSec: 3.4, reason: "segment-start", segmentId: 2, bytes: makePng(64, 128, [10, 200, 10]) },
  { timeSec: 7, reason: "final", segmentId: 2, bytes: makePng(64, 128, [10, 10, 200]) },
];

function bundle(overrides: Partial<Parameters<typeof buildBundleFiles>[0]> = {}) {
  return buildBundleFiles({
    folder: "repro-2026-08-31-1412",
    meta: {
      title: "Save button logs me out",
      summary: "Tapped save, got bounced to login.",
      folder: "repro-2026-08-31-1412",
      userAgent: "TestAgent/1.0",
    },
    source: { filename: "RPReplay_Final.mp4", durationSec: 7.4, width: 1179, height: 2556 },
    transcription: { model: "onnx-community/whisper-tiny.en", device: "wasm" },
    segments,
    captured,
    includeUserAgent: true,
    ...overrides,
  });
}

async function zipToContents(files: ReturnType<typeof buildBundleFiles>): Promise<BundleContents> {
  const blob = await createZip(files);
  const unzipped = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const map = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(unzipped)) map.set(name, bytes);
  return { files: map };
}

describe("bundle round trip", () => {
  it("produces exactly the documented file set", async () => {
    const contents = await zipToContents(bundle());
    expect([...contents.files.keys()].sort()).toEqual([
      "repro-2026-08-31-1412/README.md",
      "repro-2026-08-31-1412/frames/0001.png",
      "repro-2026-08-31-1412/frames/0002.png",
      "repro-2026-08-31-1412/frames/0003.png",
      "repro-2026-08-31-1412/frames/0004.png",
      "repro-2026-08-31-1412/manifest.json",
      "repro-2026-08-31-1412/transcript.json",
      "repro-2026-08-31-1412/transcript.md",
    ]);
  });

  it("passes the validator", async () => {
    const report = validateBundle(await zipToContents(bundle()));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.frameCount).toBe(4);
    expect(report.segmentCount).toBe(2);
  });

  it("round trips PNG bytes unchanged", async () => {
    const contents = await zipToContents(bundle());
    const stored = contents.files.get("repro-2026-08-31-1412/frames/0002.png")!;
    expect(Array.from(stored)).toEqual(Array.from(captured[1]!.bytes));
    expect(pngSize(stored)).toEqual({ width: 64, height: 128 });
  });

  it("validates a bundle with no transcript at all", async () => {
    const files = bundle({
      segments: [],
      captured: captured.map((f) => ({ timeSec: f.timeSec, reason: "interval" as const, bytes: f.bytes })),
      transcription: { model: "none", device: "none" },
    });
    const report = validateBundle(await zipToContents(files));
    expect(report.errors).toEqual([]);
    expect(report.segmentCount).toBe(0);
  });
});

describe("validateBundle", () => {
  it("catches a frame listed in the manifest but missing from the ZIP", async () => {
    const contents = await zipToContents(bundle());
    contents.files.delete("repro-2026-08-31-1412/frames/0003.png");
    const report = validateBundle(contents);
    expect(report.errors.join("\n")).toContain("frames/0003.png is missing");
  });

  it("catches a PNG that is not in the manifest", async () => {
    const contents = await zipToContents(bundle());
    contents.files.set("repro-2026-08-31-1412/frames/9999.png", makePng(8, 8));
    expect(validateBundle(contents).errors.join("\n")).toContain("not listed in manifest.json");
  });

  it("catches non-monotonic frame times", async () => {
    const contents = await zipToContents(bundle());
    const manifest = JSON.parse(
      new TextDecoder().decode(contents.files.get("repro-2026-08-31-1412/manifest.json")!),
    );
    manifest.frames[2].timeSec = 0.5;
    contents.files.set(
      "repro-2026-08-31-1412/manifest.json",
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
    expect(validateBundle(contents).errors.join("\n")).toContain("goes backwards");
  });

  it("catches a bad folder name", async () => {
    const contents = await zipToContents(bundle({ folder: "my-bundle" }));
    expect(validateBundle(contents).errors.join("\n")).toContain("is not repro-YYYY-MM-DD-HHMM");
  });

  it("catches a frame wider than the 1280 px rule", async () => {
    const contents = await zipToContents(
      bundle({ captured: [{ timeSec: 0, reason: "final", bytes: makePng(1400, 40) }] }),
    );
    expect(validateBundle(contents).errors.join("\n")).toContain("longest edge over 1280");
  });

  it("warns when a segment has no frame of its own", async () => {
    const contents = await zipToContents(
      bundle({ captured: captured.map((f) => ({ ...f, segmentId: 1 })) }),
    );
    const report = validateBundle(contents);
    expect(report.errors).toEqual([]);
    expect(report.warnings.join("\n")).toContain("no frame of their own");
  });
});
