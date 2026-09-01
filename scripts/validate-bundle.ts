/**
 * Bundle structure validator.
 *
 *   npm run validate-bundle -- path/to/repro-2026-08-31-1412.zip
 *   npm run validate-bundle -- path/to/repro-2026-08-31-1412/
 *
 * Checks everything section 5 of the plan promises: the file set, the schema
 * strings, timestamp monotonicity, that every manifest frame exists, and that
 * every transcript segment has at least one frame pointing at it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { unzipSync } from "fflate";
import { validateBundle, type BundleContents } from "./bundle-rules";

function loadZip(path: string): BundleContents {
  const unzipped = unzipSync(new Uint8Array(readFileSync(path)));
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(unzipped)) {
    if (name.endsWith("/")) continue;
    files.set(name, bytes);
  }
  return { files };
}

function loadDir(root: string): BundleContents {
  const files = new Map<string, Uint8Array>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(join(root, ".."), full).split(sep).join("/"), readFileSync(full));
    }
  };
  walk(root);
  return { files };
}

function main(): void {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: validate-bundle <bundle.zip | bundle-directory>");
    process.exit(2);
  }
  const contents = statSync(target).isDirectory()
    ? loadDir(target.replace(/[\\/]+$/, ""))
    : loadZip(target);

  const report = validateBundle(contents);
  for (const warning of report.warnings) console.warn(`warning: ${warning}`);
  if (report.errors.length > 0) {
    for (const error of report.errors) console.error(`error: ${error}`);
    console.error(`\n${report.errors.length} problem(s) in ${target}`);
    process.exit(1);
  }
  console.log(
    `ok: ${target}\n  folder: ${report.folder}\n  frames: ${report.frameCount}\n  segments: ${report.segmentCount}`,
  );
}

main();
