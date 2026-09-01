/**
 * Checks the two things about this app that only exist in a built, served,
 * service-worker-controlled page: it still loads with the network off, and the
 * Android share-target endpoint hands a shared file to the app.
 *
 *   npm run build && npm run check-pwa
 *
 * The share-target check exercises the service worker's POST handler directly.
 * It cannot exercise the OS share sheet, which is Android's side of the
 * contract and still needs a phone.
 */

import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { preview, type PreviewServer } from "vite";
import { findChromium } from "./browser";

async function main(): Promise<void> {
  if (!existsSync("dist/index.html")) {
    console.error("dist/ is missing: run `npm run build` first");
    process.exit(2);
  }

  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(name);
  };

  try {
    server = await preview({ preview: { port: 5198, strictPort: true }, logLevel: "warn" });
    const base = "http://localhost:5198";

    browser = await chromium.launch({ headless: true, executablePath: findChromium() });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(base);
    await page.waitForSelector("#choose");
    const registered = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active);
    });
    check("service worker takes control", registered);

    // A second load populates the runtime cache with the hashed assets.
    await page.reload();
    await page.waitForSelector("#choose");
    await page.waitForTimeout(500);

    await context.setOffline(true);
    await page.reload();
    const offlineOk = await page
      .waitForSelector("#choose", { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const offlineStyled = await page.evaluate(
      () => getComputedStyle(document.querySelector(".drop")!).borderStyle === "dashed",
    );
    check("app shell loads with the network off", offlineOk);
    check("stylesheet is cached too", offlineStyled);
    await context.setOffline(false);

    // Android share sheet: a multipart POST to the manifest's action URL.
    const share = await page.evaluate(async () => {
      const form = new FormData();
      form.append("title", "Screen recording");
      form.append("video", new File([new Uint8Array([1, 2, 3, 4])], "RPReplay_Final.mp4", { type: "video/mp4" }));
      const response = await fetch("./share-target", { method: "POST", body: form });
      const cache = await caches.open("vid2claude-share-inbox");
      const stashed = await cache.match("/__shared-video");
      return {
        redirectedTo: response.url,
        stashed: Boolean(stashed),
        name: stashed?.headers.get("x-filename") ?? null,
        bytes: stashed ? (await stashed.blob()).size : 0,
      };
    });
    check("share target stashes the file", share.stashed && share.bytes === 4, JSON.stringify(share));
    check("share target redirects into the app", share.redirectedTo.includes("share-target=1"), share.redirectedTo);

    // ...and the app claims it on the next load.
    await page.goto(`${base}/?share-target=1`);
    const claimed = await page.waitForFunction(
      () => document.querySelector("#file-name")?.textContent?.includes("RPReplay_Final.mp4"),
      undefined,
      { timeout: 10_000 },
    ).then(() => true).catch(() => false);
    check("app picks the shared file up on load", claimed);
  } finally {
    await browser?.close();
    await server?.httpServer.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} PWA check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nall PWA checks passed");
  }
}

void main();
