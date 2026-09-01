/**
 * Service worker: offline app shell, plus the Android share-target receiver.
 *
 * Written as plain JavaScript on purpose. It is small, has no imports, and is
 * copied verbatim into the build, so there is no bundling step between what is
 * reviewed here and what runs on the device.
 *
 * Whisper weights are deliberately NOT cached here: transformers.js already
 * stores them in the Cache API under "transformers-cache", and mirroring a
 * 250 MB model into a second cache would double the storage cost on a phone.
 */

const SHELL_CACHE = "vid2claude-shell-v1";
const SHARE_CACHE = "vid2claude-share-inbox";
const SHARE_KEY = "/__shared-video";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // The document itself; hashed assets are picked up by the runtime cache
      // on first load.
      cache.addAll(["./", "./index.html", "./manifest.webmanifest"]).catch(() => undefined),
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("vid2claude-shell-") && key !== SHELL_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Android share sheet: a multipart POST carrying the recording.
  if (request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(handleShare(event, url));
    return;
  }

  if (request.method !== "GET") return;

  // Model weights and any other cross-origin request go straight to the
  // network; transformers.js does its own caching.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          void cachePut(SHELL_CACHE, "./index.html", response.clone());
          return response;
        })
        .catch(async () => (await caches.match("./index.html")) || (await caches.match("./")) || Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === "basic") {
            void cachePut(SHELL_CACHE, request, response.clone());
          }
          return response;
        })
        .catch((err) => {
          if (cached) return cached;
          throw err;
        });
      return cached || network;
    }),
  );
});

async function cachePut(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch {
    // Storage pressure is not worth failing a page load over.
  }
}

async function handleShare(event, url) {
  // The stash must finish before the redirect: the app reads it on load, so a
  // waitUntil() here would race the navigation.
  try {
    const formData = await event.request.formData();
    const file = formData.get("video") || formData.get("file");
    if (file && typeof file !== "string") {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(
        SHARE_KEY,
        new Response(file, {
          headers: {
            "content-type": file.type || "video/mp4",
            "x-filename": encodeFilename(file.name || "shared-recording.mp4"),
            "x-filetype": file.type || "video/mp4",
          },
        }),
      );
    }
  } catch {
    // Fall through: the app will show the picker instead.
  }
  const target = new URL("./?share-target=1", url);
  return Response.redirect(target.toString(), 303);
}

/** Header values must be latin-1; recording names can be anything. */
function encodeFilename(name) {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(name) ? name : "shared-recording.mp4";
}
