/**
 * Frame planning: decides which timestamps become PNGs.
 *
 * The plan is the union of
 *   - the start of every transcript segment,
 *   - every detected scene change,
 *   - a frame at 0 s and a frame at the end,
 *   - interval frames (used on their own when there is no transcript).
 *
 * Frames closer together than MIN_SPACING_SEC collapse into one, and the total
 * is capped: interval frames go first, then the weakest scene changes.
 */

import type { FrameReason, PlannedFrame, SceneChange, Segment } from "../types";

export const MIN_SPACING_SEC = 0.4;
export const DEFAULT_FRAME_CAP = 120;

/** Higher wins when two candidates collapse into one. */
const PRIORITY: Record<FrameReason, number> = {
  "segment-start": 3,
  "scene-change": 2,
  final: 1,
  interval: 0,
};

interface Candidate extends PlannedFrame {
  /** First and last frame of the recording are never dropped. */
  pinned: boolean;
}

export interface PlanOptions {
  durationSec: number;
  segments?: Segment[];
  sceneChanges?: SceneChange[];
  intervalSec?: number;
  frameCap?: number;
}

export function planFrames(opts: PlanOptions): PlannedFrame[] {
  const {
    durationSec,
    segments = [],
    sceneChanges = [],
    intervalSec = 2,
    frameCap = DEFAULT_FRAME_CAP,
  } = opts;

  const end = Math.max(0, durationSec);
  const candidates: Candidate[] = [];

  candidates.push({ timeSec: 0, reason: "interval", pinned: true });

  for (const seg of segments) {
    if (seg.startSec > end) continue;
    candidates.push({
      timeSec: clamp(seg.startSec, 0, end),
      reason: "segment-start",
      segmentId: seg.id,
      pinned: false,
    });
  }

  for (const change of sceneChanges) {
    if (change.timeSec > end) continue;
    candidates.push({
      timeSec: clamp(change.timeSec, 0, end),
      reason: "scene-change",
      diffScore: round3(change.diffScore),
      pinned: false,
    });
  }

  if (intervalSec > 0) {
    for (let t = intervalSec; t < end; t += intervalSec) {
      candidates.push({ timeSec: round3(t), reason: "interval", pinned: false });
    }
  }

  if (end > 0) candidates.push({ timeSec: end, reason: "final", pinned: true });

  const deduped = dedupe(candidates);
  const capped = applyCap(deduped, frameCap);
  return capped.map(({ pinned: _pinned, ...frame }) => ({
    ...frame,
    timeSec: round3(frame.timeSec),
  }));
}

/** Collapses candidates within MIN_SPACING_SEC, keeping the highest priority. */
function dedupe(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort(
    (a, b) => a.timeSec - b.timeSec || PRIORITY[b.reason] - PRIORITY[a.reason],
  );
  const kept: Candidate[] = [];
  for (const cand of sorted) {
    const prev = kept[kept.length - 1];
    if (!prev || cand.timeSec - prev.timeSec >= MIN_SPACING_SEC) {
      kept.push({ ...cand });
      continue;
    }
    // Too close to the previous kept frame. Two segment starts this close are
    // both kept so that no segment is left without its own frame.
    if (cand.reason === "segment-start" && prev.reason === "segment-start") {
      kept.push({ ...cand });
      continue;
    }
    if (PRIORITY[cand.reason] > PRIORITY[prev.reason]) {
      kept[kept.length - 1] = {
        ...cand,
        pinned: prev.pinned || cand.pinned,
        // Keep the earlier timestamp when the winner is a segment start: the
        // narration begins there, so the earlier frame is the truer "before".
        timeSec: Math.min(prev.timeSec, cand.timeSec),
      };
    } else if (prev.reason === "scene-change" && cand.reason === "scene-change") {
      prev.diffScore = Math.max(prev.diffScore ?? 0, cand.diffScore ?? 0);
    } else if (cand.pinned) {
      prev.pinned = true;
    }
  }
  return kept;
}

/**
 * Enforces the cap. Interval frames go first, then scene changes by lowest
 * diff score. If segment starts alone still exceed the cap, the most tightly
 * spaced ones go too, which can leave a short segment sharing its neighbour's
 * frame.
 */
function applyCap(frames: Candidate[], cap: number): Candidate[] {
  if (cap <= 0 || frames.length <= cap) return frames;
  const kept = [...frames];

  const dropWhere = (match: (f: Candidate) => boolean, rank: (f: Candidate) => number) => {
    const droppable = kept
      .map((f, index) => ({ f, index }))
      .filter(({ f }) => !f.pinned && match(f))
      .sort((a, b) => rank(a.f) - rank(b.f));
    for (const { index } of droppable) {
      if (kept.length - countDropped() <= cap) break;
      dropped.add(index);
    }
  };

  const dropped = new Set<number>();
  const countDropped = () => dropped.size;

  dropWhere((f) => f.reason === "interval", () => 0);
  dropWhere((f) => f.reason === "scene-change", (f) => f.diffScore ?? 0);
  dropWhere(
    (f) => f.reason === "segment-start",
    (f) => gapAround(kept, kept.indexOf(f)),
  );

  return kept.filter((_f, index) => !dropped.has(index));
}

function gapAround(frames: Candidate[], index: number): number {
  const cur = frames[index];
  if (!cur) return Infinity;
  const prev = frames[index - 1];
  const next = frames[index + 1];
  const before = prev ? cur.timeSec - prev.timeSec : Infinity;
  const after = next ? next.timeSec - cur.timeSec : Infinity;
  return Math.min(before, after);
}

/**
 * Attaches the segment each frame falls inside, so a reader of manifest.json
 * can put every screenshot next to the words spoken over it.
 */
export function attachSegmentIds(frames: PlannedFrame[], segments: Segment[]): PlannedFrame[] {
  if (segments.length === 0) return frames;
  return frames.map((frame) => {
    if (frame.segmentId !== undefined) return frame;
    const containing = segments.find(
      (s) => frame.timeSec >= s.startSec && frame.timeSec < Math.max(s.endSec, s.startSec),
    );
    const preceding = [...segments].reverse().find((s) => s.startSec <= frame.timeSec);
    const match = containing ?? preceding;
    return match ? { ...frame, segmentId: match.id } : frame;
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
