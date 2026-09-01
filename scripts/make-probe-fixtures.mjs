/**
 * Generates the tiny container samples that tests/probe.test.ts parses.
 *
 * These are committed, unlike fixtures/: they are a few kilobytes each, carry
 * no content worth looking at, and the parser is only worth trusting if it is
 * checked against files a real muxer wrote rather than bytes a test assembled.
 *
 *   node scripts/make-probe-fixtures.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const out = "tests/fixtures";
mkdirSync(out, { recursive: true });

const ffmpeg = (args) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });

/** 0.2 s of 64x48 video plus a short AAC track: enough for every box we read. */
const source = [
  "-f", "lavfi", "-i", "color=c=blue:s=64x48:d=0.2:r=10",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2",
];

ffmpeg([...source, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(out, "h264-aac.mp4")]);
ffmpeg([...source, "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(out, "hevc-aac.mp4")]);
ffmpeg([...source, "-c:v", "libaom-av1", "-cpu-used", "8", "-crf", "60", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(out, "av1-aac.mp4")]);
ffmpeg(["-display_rotation", "90", "-i", join(out, "h264-aac.mp4"), "-c", "copy", join(out, "h264-rotated.mp4")]);
ffmpeg([...source, "-c:v", "libvpx", "-b:v", "50k", "-c:a", "libopus", "-shortest", join(out, "vp8-opus.webm")]);

console.log(`wrote container samples to ${out}/`);
