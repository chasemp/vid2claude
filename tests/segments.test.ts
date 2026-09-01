import { describe, expect, it } from "vitest";
import { normalizeSegments } from "../src/audio/segments";

describe("normalizeSegments", () => {
  it("numbers segments from 1 and keeps starts monotonic", () => {
    const segments = normalizeSegments(
      [
        { timestamp: [0, 3.4], text: " So I open the settings screen." },
        { timestamp: [3.4, 7], text: " And I tap save." },
      ],
      { durationSec: 10 },
    );
    expect(segments.map((s) => s.id)).toEqual([1, 2]);
    expect(segments[0]!.text).toBe("So I open the settings screen.");
    expect(segments[1]!.startSec).toBeGreaterThanOrEqual(segments[0]!.startSec);
  });

  it("drops the duplicate a chunk overlap produces", () => {
    const segments = normalizeSegments(
      [
        { timestamp: [25, 28], text: "and then it crashes" },
        { timestamp: [25.4, 28.6], text: "And then it crashes." },
        { timestamp: [29, 31], text: "back to login" },
      ],
      { durationSec: 40 },
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]!.endSec).toBeCloseTo(28.6, 5);
  });

  it("keeps genuinely repeated words that are far apart", () => {
    const segments = normalizeSegments(
      [
        { timestamp: [1, 2], text: "it crashes" },
        { timestamp: [30, 31], text: "it crashes" },
      ],
      { durationSec: 40 },
    );
    expect(segments).toHaveLength(2);
  });

  it("fills in a missing end timestamp from the next segment", () => {
    const segments = normalizeSegments(
      [
        { timestamp: [5, null], text: "tail of the recording" },
        { timestamp: [8, 9], text: "next thing" },
      ],
      { durationSec: 12 },
    );
    expect(segments[0]!.endSec).toBe(8);
  });

  it("clamps the last segment to the duration when the end is missing", () => {
    const segments = normalizeSegments([{ timestamp: [5, null], text: "tail" }], { durationSec: 12 });
    expect(segments[0]!.endSec).toBe(12);
  });

  it("ignores blank and unusable chunks", () => {
    const segments = normalizeSegments(
      [
        { timestamp: [0, 1], text: "   " },
        { timestamp: [Number.NaN, 2], text: "no start" },
        { timestamp: [1, 2], text: "kept" },
      ],
      { durationSec: 5 },
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe("kept");
  });

  it("clamps timestamps that run past the end of the recording", () => {
    const segments = normalizeSegments([{ timestamp: [0, 99], text: "long" }], { durationSec: 10 });
    expect(segments[0]!.endSec).toBe(10);
  });

  it("sorts chunks that arrive out of order", () => {
    const segments = normalizeSegments(
      [
        { timestamp: [6, 7], text: "second" },
        { timestamp: [1, 2], text: "first" },
      ],
      { durationSec: 10 },
    );
    expect(segments.map((s) => s.text)).toEqual(["first", "second"]);
  });
});
