import { describe, expect, it } from "vitest";
import { ChangeDetector, meanAbsDiff } from "../src/video/scene-change";

function solid(rgb: [number, number, number], pixels = 16): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

describe("meanAbsDiff", () => {
  it("is 0 for identical frames", () => {
    expect(meanAbsDiff(solid([10, 20, 30]), solid([10, 20, 30]))).toBe(0);
  });

  it("is 1 for black against white", () => {
    expect(meanAbsDiff(solid([0, 0, 0]), solid([255, 255, 255]))).toBe(1);
  });

  it("ignores the alpha channel", () => {
    const a = solid([10, 10, 10]);
    const b = solid([10, 10, 10]);
    b[3] = 0;
    expect(meanAbsDiff(a, b)).toBe(0);
  });

  it("treats a mismatched buffer as a full change rather than crashing", () => {
    expect(meanAbsDiff(solid([0, 0, 0], 4), solid([0, 0, 0], 8))).toBe(1);
  });
});

describe("ChangeDetector", () => {
  it("emits only above the threshold", () => {
    const detector = new ChangeDetector({ threshold: 0.15 });
    expect(detector.push(1, 0.1)).toBeNull();
    expect(detector.push(2, 0.2)).not.toBeNull();
  });

  it("holds off until the minimum gap has passed", () => {
    const detector = new ChangeDetector({ threshold: 0.15, minGapSec: 0.75 });
    detector.push(1.0, 0.9);
    expect(detector.push(1.3, 0.9)).toBeNull();
    expect(detector.push(1.8, 0.9)).not.toBeNull();
    expect(detector.changes.map((c) => c.timeSec)).toEqual([1.0, 1.8]);
  });

  it("records the diff score with each change", () => {
    const detector = new ChangeDetector();
    detector.push(4, 0.31);
    expect(detector.changes[0]).toEqual({ timeSec: 4, diffScore: 0.31 });
  });
});
