import { describe, expect, it } from "vitest";
import { attachSegmentIds, planFrames, MIN_SPACING_SEC } from "../src/bundle/align";
import type { Segment } from "../src/types";

const segments: Segment[] = [
  { id: 1, startSec: 0, endSec: 3.4, text: "So I open the settings screen." },
  { id: 2, startSec: 3.4, endSec: 7.0, text: "And I tap save." },
  { id: 3, startSec: 7.0, endSec: 10.0, text: "Now it kicks me back to login." },
];

describe("planFrames", () => {
  it("covers the start and the end of the recording", () => {
    const frames = planFrames({ durationSec: 10, segments, intervalSec: 0 });
    expect(frames[0]!.timeSec).toBe(0);
    expect(frames.at(-1)!.timeSec).toBe(10);
    expect(frames.at(-1)!.reason).toBe("final");
  });

  it("puts a frame at every segment start", () => {
    const frames = planFrames({ durationSec: 10, segments, intervalSec: 0 });
    for (const segment of segments) {
      expect(frames.some((f) => Math.abs(f.timeSec - segment.startSec) < 1e-6)).toBe(true);
    }
  });

  it("keeps a scene change near a screen transition", () => {
    const frames = planFrames({
      durationSec: 10,
      segments,
      sceneChanges: [
        { timeSec: 2.1, diffScore: 0.31 },
        { timeSec: 5.6, diffScore: 0.42 },
        { timeSec: 8.4, diffScore: 0.27 },
      ],
      intervalSec: 0,
    });
    for (const t of [2.1, 5.6, 8.4]) {
      const nearest = Math.min(...frames.map((f) => Math.abs(f.timeSec - t)));
      expect(nearest).toBeLessThanOrEqual(0.5);
    }
  });

  it("never emits two frames closer than the minimum spacing, except adjacent segment starts", () => {
    const frames = planFrames({
      durationSec: 10,
      segments,
      sceneChanges: [{ timeSec: 3.5, diffScore: 0.9 }],
      intervalSec: 2,
    });
    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i]!.timeSec - frames[i - 1]!.timeSec;
      if (frames[i]!.reason === "segment-start" && frames[i - 1]!.reason === "segment-start") continue;
      expect(gap).toBeGreaterThanOrEqual(MIN_SPACING_SEC - 1e-9);
    }
  });

  it("is sorted by time", () => {
    const frames = planFrames({
      durationSec: 60,
      segments,
      sceneChanges: [{ timeSec: 40, diffScore: 0.5 }, { timeSec: 12, diffScore: 0.5 }],
      intervalSec: 2,
    });
    const times = frames.map((f) => f.timeSec);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("drops interval frames before scene changes when over the cap", () => {
    const sceneChanges = Array.from({ length: 10 }, (_, i) => ({
      timeSec: 1 + i * 5,
      diffScore: 0.2 + i / 100,
    }));
    const frames = planFrames({ durationSec: 120, segments, sceneChanges, intervalSec: 2, frameCap: 20 });
    expect(frames.length).toBeLessThanOrEqual(20);
    expect(frames.filter((f) => f.reason === "scene-change").length).toBe(10);
    // Segment 1 starts at 0 s, so it absorbs the pinned first frame: that
    // leaves 3 segment starts + 10 scene changes + the final frame = 14, and
    // room for 6 interval frames under a cap of 20.
    expect(frames.length).toBe(20);
    expect(frames.filter((f) => f.reason === "interval").length).toBe(6);
  });

  it("drops the weakest scene changes when scene changes alone exceed the cap", () => {
    const sceneChanges = Array.from({ length: 30 }, (_, i) => ({
      timeSec: 1 + i * 2,
      diffScore: (i + 1) / 30,
    }));
    const frames = planFrames({ durationSec: 70, sceneChanges, intervalSec: 0, frameCap: 12 });
    expect(frames.length).toBe(12);
    const scores = frames.filter((f) => f.reason === "scene-change").map((f) => f.diffScore!);
    expect(Math.min(...scores)).toBeGreaterThan(0.5);
  });

  it("honours the cap exactly", () => {
    const frames = planFrames({ durationSec: 600, segments, intervalSec: 1, frameCap: 25 });
    expect(frames.length).toBeLessThanOrEqual(25);
  });

  it("works with no transcript at all: interval frames only", () => {
    const frames = planFrames({ durationSec: 10, intervalSec: 2 });
    expect(frames.map((f) => f.reason)).toEqual([
      "interval",
      "interval",
      "interval",
      "interval",
      "interval",
      "final",
    ]);
  });
});

describe("attachSegmentIds", () => {
  it("labels each frame with the segment it falls inside", () => {
    const frames = attachSegmentIds(
      [
        { timeSec: 0, reason: "interval" },
        { timeSec: 2.1, reason: "scene-change", diffScore: 0.3 },
        { timeSec: 8.2, reason: "scene-change", diffScore: 0.3 },
      ],
      segments,
    );
    expect(frames.map((f) => f.segmentId)).toEqual([1, 1, 3]);
  });

  it("leaves frames alone when there is no transcript", () => {
    const frames = attachSegmentIds([{ timeSec: 4, reason: "interval" }], []);
    expect(frames[0]!.segmentId).toBeUndefined();
  });

  it("gives every segment at least one frame on a normal recording", () => {
    const planned = attachSegmentIds(
      planFrames({
        durationSec: 10,
        segments,
        sceneChanges: [{ timeSec: 5.6, diffScore: 0.42 }],
        intervalSec: 2,
      }),
      segments,
    );
    for (const segment of segments) {
      expect(planned.some((f) => f.segmentId === segment.id)).toBe(true);
    }
  });
});
