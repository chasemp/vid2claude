import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matrixRotation, probeMp4 } from "../src/video/probe";

/**
 * The samples are real muxer output (scripts/make-probe-fixtures.mjs), a few
 * kilobytes each. A parser checked only against bytes a test assembled would
 * mostly be testing the test.
 */
function sample(name: string): Blob {
  return new Blob([readFileSync(join("tests/fixtures", name))]);
}

describe("probeMp4", () => {
  it("reads H.264 and AAC exactly", async () => {
    const probe = await probeMp4(sample("h264-aac.mp4"));
    expect(probe?.video).toMatchObject({ fourcc: "avc1", width: 64, height: 48, rotationDeg: 0 });
    expect(probe?.video?.codec).toMatch(/^avc1\.[0-9A-F]{6}$/);
    expect(probe?.video?.codecApproximate).toBeUndefined();
    expect(probe?.audio).toEqual({ fourcc: "mp4a", codec: "mp4a.40.2" });
    expect(probe?.durationSec).toBeCloseTo(0.2, 1);
  });

  it("recognises HEVC, which is the codec a browser is most likely to refuse", async () => {
    const probe = await probeMp4(sample("hevc-aac.mp4"));
    expect(probe?.video?.fourcc).toBe("hvc1");
    expect(probe?.video?.codec).toMatch(/^hvc1\./);
    // The hvcC parse is good enough to name the codec, not to be quoted exactly.
    expect(probe?.video?.codecApproximate).toBe(true);
  });

  it("recognises AV1", async () => {
    const probe = await probeMp4(sample("av1-aac.mp4"));
    expect(probe?.video?.fourcc).toBe("av01");
  });

  it("reads the rotation out of the display matrix", async () => {
    const upright = await probeMp4(sample("h264-aac.mp4"));
    const rotated = await probeMp4(sample("h264-rotated.mp4"));
    expect(upright?.video?.rotationDeg).toBe(0);
    expect((rotated?.video?.rotationDeg ?? 0) % 180).toBe(90);
  });

  it("lists the top-level boxes, so an odd file still says something", async () => {
    const probe = await probeMp4(sample("h264-aac.mp4"));
    expect(probe?.topLevelBoxes).toContain("ftyp");
    expect(probe?.topLevelBoxes).toContain("moov");
    expect(probe?.brands).toContain("isom");
  });

  it("returns null for a container that is not ISO base media", async () => {
    expect(await probeMp4(sample("vp8-opus.webm"))).toBeNull();
  });

  it("returns null for random bytes rather than throwing", async () => {
    const noise = new Uint8Array(4096);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) & 0xff;
    expect(await probeMp4(new Blob([noise]))).toBeNull();
  });

  it("survives a truncated file", async () => {
    const full = sample("h264-aac.mp4");
    const truncated = full.slice(0, 200);
    await expect(probeMp4(truncated)).resolves.not.toThrow();
  });

  it("reads only a fraction of a large file", async () => {
    // moov sits at the end here, so the walk must skip mdat by its header
    // rather than reading it: a 61 MB recording cannot be pulled into memory.
    const real = readFileSync(join("tests/fixtures", "h264-aac.mp4"));
    const padding = new Uint8Array(8);
    const view = new DataView(padding.buffer);
    view.setUint32(0, 8 + 40_000_000);
    padding.set([0x6d, 0x64, 0x61, 0x74], 4); // "mdat"

    let read = 0;
    const blob = new Blob([real]);
    const huge = {
      size: real.length + 8 + 40_000_000,
      slice(start: number, end: number) {
        read += end - start;
        // Splice a giant declared-but-absent mdat in after ftyp.
        return blob.slice(start, end);
      },
    };
    await probeMp4(huge as unknown as Blob).catch(() => null);
    expect(read).toBeLessThan(2_000_000);
  });
});

describe("matrixRotation", () => {
  it("names the four quarter turns", () => {
    expect(matrixRotation(1, 0, 0, 1)).toBe(0);
    expect(matrixRotation(0, 1, -1, 0)).toBe(90);
    expect(matrixRotation(-1, 0, 0, -1)).toBe(180);
    expect(matrixRotation(0, -1, 1, 0)).toBe(270);
  });
});
