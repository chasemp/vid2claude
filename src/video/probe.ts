/**
 * A small MP4/MOV box reader.
 *
 * When a browser refuses a recording, `<video>` reports MEDIA_ERR_SRC_NOT_SUPPORTED
 * and nothing else: not which codec, not whether the file is even an MP4. That
 * is not enough to tell a user what to do. This walks the container far enough
 * to name the video and audio codecs, the dimensions, the duration and the
 * rotation, so the app can say what is actually wrong.
 *
 * It reads by slicing the Blob, so a 61 MB recording costs a few kilobytes of
 * reads: top-level boxes are walked by their headers, and only `moov` is read
 * in full.
 */

export interface TrackInfo {
  /** The sample entry's four-character code: avc1, hvc1, av01, mp4a, ... */
  fourcc: string;
  /** RFC 6381 codec string where it can be derived exactly, else undefined. */
  codec?: string;
  /** True when `codec` is a best guess rather than read from the config box. */
  codecApproximate?: boolean;
}

export interface VideoTrackInfo extends TrackInfo {
  width: number;
  height: number;
  /** Degrees clockwise, from the track's display matrix: 0, 90, 180 or 270. */
  rotationDeg: number;
}

export interface Mp4Probe {
  /** ftyp major brand plus compatible brands, e.g. isom, mp42, qt. */
  brands: string[];
  durationSec?: number;
  video?: VideoTrackInfo;
  audio?: TrackInfo;
  /** Boxes found at the top level, in order. Useful when nothing else parses. */
  topLevelBoxes: string[];
}

const MAX_MOOV_BYTES = 64 * 1024 * 1024;

/** Returns null when the file is not an ISO base media file at all. */
export async function probeMp4(file: Blob): Promise<Mp4Probe | null> {
  const topLevelBoxes: string[] = [];
  const brands: string[] = [];
  let moov: DataView | null = null;

  let offset = 0;
  // Walk the top level by headers only; `mdat` is skipped, not read.
  while (offset < file.size && topLevelBoxes.length < 64) {
    const header = await readBoxHeader(file, offset);
    if (!header) break;
    topLevelBoxes.push(header.type);

    if (header.type === "ftyp") {
      const bytes = await sliceView(file, header.bodyStart, Math.min(header.end, header.bodyStart + 64));
      for (let i = 0; i + 4 <= bytes.byteLength; i += 4) {
        if (i === 4) continue; // minor_version, not a brand
        const brand = fourcc(bytes, i).trim();
        if (brand) brands.push(brand);
      }
    } else if (header.type === "moov") {
      const size = header.end - header.bodyStart;
      if (size > 0 && size < MAX_MOOV_BYTES) {
        moov = await sliceView(file, header.bodyStart, header.end);
      }
    }

    if (header.end <= offset) break;
    offset = header.end;
  }

  if (topLevelBoxes.length === 0 || !topLevelBoxes.includes("ftyp")) {
    // Not an ISO base media file; the caller should say so rather than guess.
    if (!topLevelBoxes.includes("moov")) return null;
  }
  if (!moov) return { brands, topLevelBoxes };

  const probe: Mp4Probe = { brands, topLevelBoxes };
  const mvhd = findBox(moov, 0, moov.byteLength, ["mvhd"]);
  if (mvhd) probe.durationSec = readMvhdDuration(moov, mvhd.bodyStart);

  for (const trak of findBoxes(moov, 0, moov.byteLength, "trak")) {
    const tkhd = findBox(moov, trak.bodyStart, trak.end, ["tkhd"]);
    const stsd = findBox(moov, trak.bodyStart, trak.end, ["mdia", "minf", "stbl", "stsd"]);
    if (!stsd) continue;
    const entry = readFirstSampleEntry(moov, stsd.bodyStart, stsd.end);
    if (!entry) continue;

    if (isVideoFourcc(entry.fourcc)) {
      const track = tkhd ? readTkhd(moov, tkhd.bodyStart) : null;
      probe.video = {
        ...describeVideo(moov, entry),
        width: track?.width || entry.width,
        height: track?.height || entry.height,
        rotationDeg: track?.rotationDeg ?? 0,
      };
    } else if (isAudioFourcc(entry.fourcc)) {
      probe.audio = describeAudio(moov, entry);
    }
  }

  return probe;
}

interface BoxHeader {
  type: string;
  start: number;
  bodyStart: number;
  end: number;
}

async function readBoxHeader(file: Blob, offset: number): Promise<BoxHeader | null> {
  if (offset + 8 > file.size) return null;
  const head = await sliceView(file, offset, Math.min(offset + 16, file.size));
  if (head.byteLength < 8) return null;
  let size = head.getUint32(0);
  const type = fourcc(head, 4);
  let bodyStart = offset + 8;
  if (size === 1) {
    if (head.byteLength < 16) return null;
    // 64-bit size. Number is exact well past any real recording.
    size = Number(head.getBigUint64(8));
    bodyStart = offset + 16;
  } else if (size === 0) {
    size = file.size - offset;
  }
  if (size < 8) return null;
  return { type, start: offset, bodyStart, end: Math.min(offset + size, file.size) };
}

async function sliceView(file: Blob, start: number, end: number): Promise<DataView> {
  const buffer = await file.slice(start, end).arrayBuffer();
  return new DataView(buffer);
}

function fourcc(view: DataView, offset: number): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    const code = view.getUint8(offset + i);
    out += code >= 32 && code < 127 ? String.fromCharCode(code) : "";
  }
  return out;
}

/** Iterates the direct children of a box body. */
function* children(view: DataView, start: number, end: number): Generator<BoxHeader> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = fourcc(view, offset + 4);
    let bodyStart = offset + 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(view.getBigUint64(offset + 8));
      bodyStart = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < 8) return;
    const boxEnd = Math.min(offset + size, end);
    yield { type, start: offset, bodyStart, end: boxEnd };
    if (boxEnd <= offset) return;
    offset = boxEnd;
  }
}

function findBoxes(view: DataView, start: number, end: number, type: string): BoxHeader[] {
  return [...children(view, start, end)].filter((box) => box.type === type);
}

/** Follows a path of box types down from a body range. */
function findBox(view: DataView, start: number, end: number, path: string[]): BoxHeader | null {
  let range = { start, end };
  let found: BoxHeader | null = null;
  for (const type of path) {
    found = [...children(view, range.start, range.end)].find((box) => box.type === type) ?? null;
    if (!found) return null;
    range = { start: found.bodyStart, end: found.end };
  }
  return found;
}

function readMvhdDuration(view: DataView, bodyStart: number): number | undefined {
  const version = view.getUint8(bodyStart);
  let offset = bodyStart + 4;
  let timescale: number;
  let duration: number;
  if (version === 1) {
    offset += 16; // creation + modification time
    timescale = view.getUint32(offset);
    duration = Number(view.getBigUint64(offset + 4));
  } else {
    offset += 8;
    timescale = view.getUint32(offset);
    duration = view.getUint32(offset + 4);
  }
  if (!timescale) return undefined;
  return Math.round((duration / timescale) * 1000) / 1000;
}

interface TkhdInfo {
  width: number;
  height: number;
  rotationDeg: number;
}

function readTkhd(view: DataView, bodyStart: number): TkhdInfo {
  const version = view.getUint8(bodyStart);
  // version/flags(4) + times + trackID + reserved + duration
  let offset = bodyStart + 4 + (version === 1 ? 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4);
  offset += 8; // reserved
  offset += 2 + 2 + 2 + 2; // layer, alternate_group, volume, reserved

  // 3x3 display matrix; a, b, c, d are 16.16 fixed point.
  const a = view.getInt32(offset) / 65536;
  const b = view.getInt32(offset + 4) / 65536;
  const c = view.getInt32(offset + 12) / 65536;
  const d = view.getInt32(offset + 16) / 65536;
  offset += 36;

  const width = view.getUint32(offset) / 65536;
  const height = view.getUint32(offset + 4) / 65536;

  return {
    width: Math.round(width),
    height: Math.round(height),
    rotationDeg: matrixRotation(a, b, c, d),
  };
}

/** 0, 90, 180 or 270 degrees clockwise from the display matrix. */
export function matrixRotation(a: number, b: number, c: number, d: number): number {
  const near = (value: number, target: number) => Math.abs(value - target) < 0.01;
  if (near(a, 1) && near(b, 0) && near(c, 0) && near(d, 1)) return 0;
  if (near(a, 0) && near(b, 1) && near(c, -1) && near(d, 0)) return 90;
  if (near(a, -1) && near(b, 0) && near(c, 0) && near(d, -1)) return 180;
  if (near(a, 0) && near(b, -1) && near(c, 1) && near(d, 0)) return 270;
  // Anything else (flips, shears) is not a plain rotation.
  const degrees = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((degrees % 360) + 360) % 360;
}

interface SampleEntry {
  fourcc: string;
  width: number;
  height: number;
  bodyStart: number;
  end: number;
  /** Where the child config boxes (avcC, hvcC, esds, ...) begin. */
  configStart: number;
}

function readFirstSampleEntry(view: DataView, bodyStart: number, end: number): SampleEntry | null {
  // stsd: version/flags(4), entry_count(4), then sample entries.
  const entriesStart = bodyStart + 8;
  const entry = [...children(view, entriesStart, end)][0];
  if (!entry) return null;
  const isVideo = isVideoFourcc(entry.type);
  // Both start with reserved(6) + data_reference_index(2).
  const afterCommon = entry.bodyStart + 8;
  if (isVideo) {
    const width = view.getUint16(afterCommon + 16);
    const height = view.getUint16(afterCommon + 18);
    return {
      fourcc: entry.type,
      width,
      height,
      bodyStart: entry.bodyStart,
      end: entry.end,
      configStart: afterCommon + 70,
    };
  }
  return {
    fourcc: entry.type,
    width: 0,
    height: 0,
    bodyStart: entry.bodyStart,
    end: entry.end,
    // Audio sample entry v0: reserved(8) channels(2) samplesize(2) pre(2) res(2) rate(4)
    configStart: afterCommon + 20,
  };
}

const VIDEO_FOURCCS = new Set([
  "avc1", "avc3", "hvc1", "hev1", "av01", "vp08", "vp09", "mp4v", "dvh1", "dvhe", "jpeg",
]);
const AUDIO_FOURCCS = new Set(["mp4a", "Opus", "opus", "ac-3", "ec-3", "alac", "sowt", "twos", "fLaC"]);

function isVideoFourcc(code: string): boolean {
  return VIDEO_FOURCCS.has(code);
}

function isAudioFourcc(code: string): boolean {
  return AUDIO_FOURCCS.has(code);
}

function describeVideo(view: DataView, entry: SampleEntry): TrackInfo {
  const configs = [...children(view, entry.configStart, entry.end)];
  const avcC = configs.find((box) => box.type === "avcC");
  if (avcC && entry.fourcc.startsWith("avc")) {
    const profile = view.getUint8(avcC.bodyStart + 1);
    const compat = view.getUint8(avcC.bodyStart + 2);
    const level = view.getUint8(avcC.bodyStart + 3);
    return {
      fourcc: entry.fourcc,
      codec: `${entry.fourcc}.${hex2(profile)}${hex2(compat)}${hex2(level)}`,
    };
  }

  const hvcC = configs.find((box) => box.type === "hvcC");
  if (hvcC) {
    const byte1 = view.getUint8(hvcC.bodyStart + 1);
    const profileSpace = byte1 >> 6;
    const tierFlag = (byte1 >> 5) & 1;
    const profileIdc = byte1 & 0x1f;
    const level = view.getUint8(hvcC.bodyStart + 12);
    const space = ["", "A", "B", "C"][profileSpace] ?? "";
    return {
      fourcc: entry.fourcc,
      codec: `${entry.fourcc}.${space}${profileIdc}.4.${tierFlag ? "H" : "L"}${level}.B0`,
      codecApproximate: true,
    };
  }

  if (entry.fourcc === "av01") {
    return { fourcc: entry.fourcc, codec: "av01.0.08M.08", codecApproximate: true };
  }
  return { fourcc: entry.fourcc };
}

function describeAudio(view: DataView, entry: SampleEntry): TrackInfo {
  if (entry.fourcc === "mp4a") {
    const esds = [...children(view, entry.configStart, entry.end)].find((box) => box.type === "esds");
    if (esds) {
      const objectType = findEsdsObjectType(view, esds.bodyStart + 4, esds.end);
      if (objectType === 0x40) return { fourcc: "mp4a", codec: "mp4a.40.2" };
      if (objectType !== null) return { fourcc: "mp4a", codec: `mp4a.${hex2(objectType)}` };
    }
    return { fourcc: "mp4a", codec: "mp4a.40.2", codecApproximate: true };
  }
  return { fourcc: entry.fourcc };
}

/** Walks the ES descriptor far enough to find objectTypeIndication. */
function findEsdsObjectType(view: DataView, start: number, end: number): number | null {
  let offset = start;
  while (offset < end - 1) {
    const tag = view.getUint8(offset);
    offset += 1;
    let length = 0;
    for (let i = 0; i < 4 && offset < end; i++) {
      const byte = view.getUint8(offset);
      offset += 1;
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    if (tag === 0x03) {
      // ES_Descriptor: ES_ID(2) + flags(1), then the DecoderConfigDescriptor.
      offset += 3;
      continue;
    }
    if (tag === 0x04) return view.getUint8(offset);
    offset += length;
  }
  return null;
}

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0").toUpperCase();
}
