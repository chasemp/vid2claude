/**
 * Builds synthetic screen recordings for the spike harness and the test matrix.
 *
 * Real recordings from real phones are the ground truth (see fixtures/README.md),
 * but they cannot be committed, and CI has no phone. These fixtures are
 * generated instead: known screen transitions at known times, and known
 * narration at known times, so a spike can assert against the truth.
 *
 * Requires ffmpeg and espeak-ng on PATH.
 *
 *   node scripts/make-fixture.mjs [outputDir]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? "fixtures";
const tmp = join(outDir, ".tmp");
mkdirSync(tmp, { recursive: true });

/** Each screen is a flat colour held for `hold` seconds, with its label burnt in. */
const SCREENS = [
  { color: "0x1d3557", label: "SETTINGS" },
  { color: "0xe63946", label: "SAVING" },
  { color: "0xf1faee", label: "LOGIN" },
  { color: "0x2a9d8f", label: "SETTINGS" },
];
const HOLD_SEC = 3;
const WIDTH = 720;
const HEIGHT = 1280; // portrait, like a phone recording
const FPS = 30;

/** Narration lines, one per screen, spoken at the start of each screen. */
const LINES = [
  "So I open the settings screen.",
  "And I tap the save button.",
  "Now it kicks me back to the login page.",
  "I open settings again and my change is gone.",
];

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}

function buildVideoTrack() {
  const parts = [];
  SCREENS.forEach((screen, index) => {
    const path = join(tmp, `screen-${index}.mp4`);
    ffmpeg([
      "-f", "lavfi",
      "-i", `color=c=${screen.color}:s=${WIDTH}x${HEIGHT}:d=${HOLD_SEC}:r=${FPS}`,
      "-vf", `drawtext=text='${screen.label}':fontcolor=black:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level", "3.0",
      path,
    ]);
    parts.push(path);
  });
  const listPath = join(tmp, "concat.txt");
  writeFileSync(listPath, parts.map((p) => `file '${p.split("/").pop()}'`).join("\n"));
  const videoPath = join(tmp, "video.mp4");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", videoPath]);
  return videoPath;
}

function buildAudioTrack() {
  // One spoken line per screen, each padded to start exactly at its screen.
  const clips = [];
  LINES.forEach((line, index) => {
    const raw = join(tmp, `line-${index}.wav`);
    execFileSync("espeak-ng", ["-s", "150", "-v", "en-us", "-w", raw, line]);
    const padded = join(tmp, `line-${index}-16k.wav`);
    ffmpeg([
      "-i", raw,
      "-af", `apad=whole_dur=${HOLD_SEC}`,
      "-ar", "16000", "-ac", "1",
      padded,
    ]);
    clips.push(padded);
  });
  const listPath = join(tmp, "audio-concat.txt");
  writeFileSync(listPath, clips.map((p) => `file '${p.split("/").pop()}'`).join("\n"));
  const audioPath = join(tmp, "audio.wav");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", audioPath]);
  return audioPath;
}

function mux(videoPath, audioPath, outPath, extraArgs = [], videoInputArgs = []) {
  ffmpeg([
    ...videoInputArgs,
    "-i", videoPath,
    "-i", audioPath,
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "96k",
    "-shortest",
    ...extraArgs,
    outPath,
  ]);
}

mkdirSync(outDir, { recursive: true });
const video = buildVideoTrack();
const audio = buildAudioTrack();

// The everyday case: H.264 + AAC in MP4, exactly what a phone recorder writes.
mux(video, audio, join(outDir, "synthetic-portrait.mp4"));

// Same content, tagged with a 90 degree display matrix: phone recorders write
// the sensor's pixels plus a rotation matrix, and a browser is expected to
// apply it (assumption A5).
mux(video, audio, join(outDir, "synthetic-rotated.mp4"), [], ["-display_rotation", "90"]);

// A codec set every browser can decode, used when the runner's browser build
// has no proprietary codecs.
ffmpeg([
  "-i", video,
  "-i", audio,
  "-c:v", "libvpx", "-b:v", "1M", "-c:a", "libopus", "-shortest",
  join(outDir, "synthetic-portrait.webm"),
]);

writeFileSync(
  join(outDir, "synthetic-truth.json"),
  JSON.stringify(
    {
      widthPx: WIDTH,
      heightPx: HEIGHT,
      holdSec: HOLD_SEC,
      durationSec: SCREENS.length * HOLD_SEC,
      screenChangesSec: SCREENS.map((_s, i) => i * HOLD_SEC).slice(1),
      screens: SCREENS.map((s, i) => ({ startSec: i * HOLD_SEC, label: s.label, color: s.color })),
      narration: LINES.map((text, i) => ({ startSec: i * HOLD_SEC, text })),
    },
    null,
    2,
  ) + "\n",
);

rmSync(tmp, { recursive: true, force: true });
console.log(`fixtures written to ${outDir}/`);
