/**
 * ZIP writing. Uses fflate's streaming Zip so frames are appended one at a
 * time and never all held as separate JS objects at once (A3 in docs/spikes.md).
 *
 * PNGs are stored without deflate: they are already compressed, so deflating
 * them costs CPU on a phone and saves almost nothing.
 */

import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
  /** Skip deflate for already-compressed data. */
  store?: boolean;
}

export interface ZipOptions {
  signal?: AbortSignal;
  onProgress?: (entriesWritten: number, bytesWritten: number) => void;
}

export async function createZip(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  opts: ZipOptions = {},
): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  let bytesWritten = 0;
  let entriesWritten = 0;

  let settle: () => void = () => {};
  let failed: (err: Error) => void = () => {};
  let failure: Error | null = null;
  const finished = new Promise<void>((resolve, reject) => {
    settle = resolve;
    failed = reject;
  });
  // Nothing is awaiting `finished` yet; keep it from becoming an unhandled
  // rejection if fflate reports an error before we get to the await.
  finished.catch(() => {});

  const zip = new Zip((err, data, final) => {
    if (err) {
      failure = err;
      failed(err);
      return;
    }
    if (data.length) {
      chunks.push(data);
      bytesWritten += data.length;
    }
    if (final) settle();
  });

  for await (const entry of entries) {
    if (opts.signal?.aborted) {
      zip.terminate();
      throw new DOMException("cancelled", "AbortError");
    }
    if (failure) throw failure;
    const file = entry.store
      ? new ZipPassThrough(entry.path)
      : new ZipDeflate(entry.path, { level: 6 });
    zip.add(file);
    file.push(entry.bytes, true);
    entriesWritten += 1;
    opts.onProgress?.(entriesWritten, bytesWritten);
    // Yield so the progress UI can paint between frames.
    await Promise.resolve();
  }

  zip.end();
  await finished;
  return new Blob(chunks as BlobPart[], { type: "application/zip" });
}

export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function encodeJson(value: unknown): Uint8Array {
  return encodeText(JSON.stringify(value, null, 2) + "\n");
}
