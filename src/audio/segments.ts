/**
 * Turns raw Whisper chunks into the `segments` array of transcript.json.
 *
 * Whisper's long-form chunking overlaps windows, so the same words can come
 * back twice with slightly different timestamps; a chunk can also arrive with a
 * null end timestamp when the model ran out of audio mid-window.
 */

import type { Segment } from "../types";

export interface RawChunk {
  timestamp: [number, number | null];
  text: string;
}

export interface NormalizeOptions {
  durationSec: number;
  /** Chunks starting within this many seconds of the previous one, with the
   * same text, are treated as an overlap duplicate. */
  dedupeWindowSec?: number;
}

export function normalizeSegments(chunks: RawChunk[], opts: NormalizeOptions): Segment[] {
  const { durationSec, dedupeWindowSec = 1.0 } = opts;
  const cleaned: { start: number; end: number; text: string }[] = [];

  for (const chunk of chunks) {
    const text = chunk.text.trim();
    if (!text) continue;
    const rawStart = Number(chunk.timestamp[0]);
    if (!Number.isFinite(rawStart)) continue;
    const start = clamp(rawStart, 0, durationSec);
    const rawEnd = chunk.timestamp[1];
    const end = Number.isFinite(Number(rawEnd)) ? clamp(Number(rawEnd), start, durationSec) : start;
    cleaned.push({ start, end, text });
  }

  cleaned.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: { start: number; end: number; text: string }[] = [];
  for (const seg of cleaned) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      normalizeText(prev.text) === normalizeText(seg.text) &&
      seg.start - prev.start <= dedupeWindowSec
    ) {
      // Same words from an overlapping window: keep the widest span.
      prev.end = Math.max(prev.end, seg.end);
      continue;
    }
    // Keep starts strictly non-decreasing and ends sane.
    const start = prev ? Math.max(seg.start, prev.start) : seg.start;
    merged.push({ start, end: Math.max(seg.end, start), text: seg.text });
  }

  // A chunk with a missing end timestamp borrows the next chunk's start.
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]!;
    if (cur.end <= cur.start) {
      const next = merged[i + 1];
      cur.end = next ? Math.max(cur.start, next.start) : Math.max(cur.start, durationSec);
    }
  }

  return merged.map((seg, i) => ({
    id: i + 1,
    startSec: round3(seg.start),
    endSec: round3(seg.end),
    text: seg.text,
  }));
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
