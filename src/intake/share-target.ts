/**
 * Android share-target intake.
 *
 * The service worker receives the POSTed multipart form, stashes the file in
 * the Cache API, and redirects to `/?share-target=1`. On load the app claims
 * the stashed file from that cache. iOS and Firefox never take this path:
 * `share_target` is Chromium-only (docs/spikes.md, constraint C2).
 */

export const SHARE_CACHE = "vid2claude-share-inbox";
export const SHARE_KEY = "/__shared-video";
export const SHARE_FLAG = "share-target";

export function hasPendingShare(): boolean {
  return new URLSearchParams(location.search).has(SHARE_FLAG);
}

/** Reads and removes the file the service worker stashed. */
export async function claimSharedFile(): Promise<File | null> {
  if (!("caches" in self)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const response = await cache.match(SHARE_KEY);
  if (!response) return null;
  const name = response.headers.get("x-filename") || "shared-recording.mp4";
  const type = response.headers.get("x-filetype") || "video/mp4";
  const blob = await response.blob();
  await cache.delete(SHARE_KEY);
  clearShareFlag();
  return new File([blob], name, { type });
}

export function clearShareFlag(): void {
  const url = new URL(location.href);
  if (url.searchParams.has(SHARE_FLAG)) {
    url.searchParams.delete(SHARE_FLAG);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
}

/**
 * True when this browser can register as a share target at all. Used to hide
 * the "share to this app" instructions rather than show a dead affordance.
 */
export function supportsShareTarget(): boolean {
  const ua = navigator.userAgent;
  const isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS) return false;
  // share_target is a manifest feature of Chromium browsers; the closest
  // runtime proxy is Chromium's own launch-queue/PWA surface.
  return /Chrome|Chromium|Edg/.test(ua) && !/Firefox/.test(ua);
}
