import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Playwright's own browser download is disabled in some environments
 * (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD), and the pre-installed build can be a
 * different revision than the npm package expects. Prefer whatever is on disk.
 */
export function findChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const candidates = readdirSync(root)
    .filter((entry) => entry.startsWith("chromium-"))
    .map((entry) => join(root, entry, "chrome-linux", "chrome"))
    .filter((path) => existsSync(path));
  return candidates[0];
}
