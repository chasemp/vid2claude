/**
 * The whole interface. Vanilla DOM: on a phone this page is doing GPU
 * inference and video decoding at the same time, so the view layer should cost
 * as close to nothing as possible.
 */

import "./styles.css";
import { ACCEPT_ATTR, enableDropTarget, looksLikeVideo, pickFile } from "../intake/picker";
import { claimSharedFile, hasPendingShare, supportsShareTarget } from "../intake/share-target";
import { downloadBlob } from "../export/download";
import { canShareFile, shareFile, zipAsFile } from "../export/share";
import { commitBundle, defaultBranchName, GithubError, verifyAccess } from "../export/github";
import { runPipeline, type RunResult, type StageUpdate } from "../pipeline";
import { VideoLoadError } from "../video/frames";
import { diagnoseVideo, formatDiagnostics, type Diagnosis } from "../video/diagnose";
import { defaultTitle } from "../bundle/manifest";
import { DEFAULT_SETTINGS, MODELS, type Settings } from "../types";
import { KEYS, del, get, set } from "../store";

const STAGE_LABEL: Record<StageUpdate["stage"], string> = {
  opening: "Reading the recording",
  scanning: "Looking for screen changes",
  "decoding-audio": "Decoding the audio track",
  transcribing: "Transcribing the narration",
  capturing: "Capturing frames",
  zipping: "Writing the ZIP",
  done: "Done",
};

export async function mount(root: HTMLElement): Promise<void> {
  const settings = await loadSettings();
  let file: File | null = null;
  let controller: AbortController | null = null;
  let result: RunResult | null = null;

  root.insertAdjacentHTML("beforeend", template(settings));
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

  const drop = $("drop");
  const chooseBtn = $<HTMLButtonElement>("choose");
  const fileName = $("file-name");
  const startBtn = $<HTMLButtonElement>("start");
  const cancelBtn = $<HTMLButtonElement>("cancel");
  const progress = $("progress");
  const stageText = $("stage");
  const bar = $<HTMLDivElement>("bar-fill");
  const notices = $("notices");
  const resultBox = $("result");
  const titleInput = $<HTMLInputElement>("title");
  const summaryInput = $<HTMLTextAreaElement>("summary");
  const shareHelp = $("share-help");

  titleInput.value = defaultTitle();
  if (!supportsShareTarget()) shareHelp.classList.add("hidden");

  // Offline use, the share target and WebGPU all require a secure context.
  // Served over plain HTTP the app still processes a file, but silently loses
  // all three, so say so rather than letting the user discover it.
  if (!window.isSecureContext) {
    addNotice(
      notices,
      "warn",
      `This page is not being served over HTTPS. Processing still works, but the app ` +
        `cannot be installed, cannot work offline, cannot receive shared files, and ` +
        `falls back to the slower CPU path for transcription. Open it over https:// instead.`,
    );
  }

  const setFile = (next: File | null) => {
    file = next;
    fileName.textContent = next ? `${next.name} · ${formatBytes(next.size)}` : "No file chosen yet.";
    startBtn.disabled = next === null;
  };
  setFile(null);

  enableDropTarget(
    drop,
    (dropped) => setFile(dropped),
    (active) => drop.classList.toggle("active", active),
  );

  chooseBtn.addEventListener("click", async () => {
    const picked = await pickFile();
    if (!picked) return;
    if (!looksLikeVideo(picked)) {
      addNotice(notices, "error", "That does not look like a video file.");
      return;
    }
    setFile(picked);
  });

  // Settings bindings
  bindSettings(root, settings, () => void saveSettings(settings));

  startBtn.addEventListener("click", async () => {
    if (!file) return;
    notices.replaceChildren();
    resultBox.replaceChildren();
    resultBox.classList.add("hidden");
    progress.classList.remove("hidden");
    startBtn.disabled = true;
    cancelBtn.disabled = false;
    controller = new AbortController();

    const started = performance.now();
    try {
      result = await runPipeline({
        file,
        settings,
        title: titleInput.value.trim() || defaultTitle(),
        summary: summaryInput.value,
        signal: controller.signal,
        onWarning: (message) => addNotice(notices, "warn", message),
        onStage: (update) => {
          const label = STAGE_LABEL[update.stage];
          stageText.textContent = update.detail ? `${label} — ${update.detail}` : label;
          bar.style.width = `${Math.round((update.fraction ?? 0) * 100)}%`;
        },
      });
      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      renderResult(resultBox, result, settings, notices, elapsed);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        addNotice(notices, "warn", "Cancelled. Nothing was written.");
      } else if (err instanceof VideoLoadError && file) {
        // Say which codec the file actually uses, rather than repeating the
        // browser's "media error 4".
        addDiagnosis(notices, await diagnoseVideo(file, err.mediaError));
      } else {
        addNotice(notices, "error", err instanceof Error ? err.message : String(err));
      }
    } finally {
      progress.classList.add("hidden");
      startBtn.disabled = file === null;
      cancelBtn.disabled = true;
      controller = null;
    }
  });

  cancelBtn.addEventListener("click", () => controller?.abort());

  if (hasPendingShare()) {
    const shared = await claimSharedFile();
    if (shared) {
      setFile(shared);
      addNotice(notices, "warn", `Received ${shared.name} from the share sheet. Press Process to start.`);
    }
  }
}

function template(settings: Settings): string {
  return `
  <div class="drop" id="drop">
    <button class="primary" id="choose" type="button">Choose a recording</button>
    <p id="file-name">No file chosen yet.</p>
    <p>Accepted: ${ACCEPT_ATTR.replace(/,/g, ", ")}</p>
  </div>

  <p class="muted" id="share-help">
    Installed on Android? Share a recording straight from your gallery to vid2claude.
  </p>

  <label for="title">Title</label>
  <input type="text" id="title" placeholder="Bug reproduction" />

  <label for="summary">What were you trying to do, and what went wrong? (optional)</label>
  <textarea id="summary" placeholder="Tapped Save on the settings screen; the app returned to the login page."></textarea>

  <details>
    <summary>Settings</summary>

    <div class="check">
      <input type="checkbox" id="transcribe" ${settings.transcribe ? "checked" : ""} />
      <label for="transcribe" style="margin:0">Transcribe the narration</label>
    </div>

    <label for="model">Speech model</label>
    <select id="model">
      ${MODELS.map(
        (m) =>
          `<option value="${m.id}" ${m.id === settings.model ? "selected" : ""}>${m.label} — ${m.approxDownload}</option>`,
      ).join("")}
    </select>
    <p class="muted">Downloaded once, then cached for offline use.</p>

    <div class="row">
      <div>
        <label for="interval">Frame interval (s)</label>
        <input type="number" id="interval" min="0" step="0.5" value="${settings.frameIntervalSec}" />
      </div>
      <div>
        <label for="cap">Maximum frames</label>
        <input type="number" id="cap" min="2" step="1" value="${settings.frameCap}" />
      </div>
      <div>
        <label for="threshold">Scene-change threshold</label>
        <input type="number" id="threshold" min="0.01" max="1" step="0.01" value="${settings.sceneThreshold}" />
      </div>
    </div>

    <div class="check">
      <input type="checkbox" id="include-ua" ${settings.includeUserAgent ? "checked" : ""} />
      <label for="include-ua" style="margin:0">Put this device's user agent in README.md</label>
    </div>

    <h2>Commit to GitHub (optional)</h2>
    <div class="row">
      <div>
        <label for="repo">Repository</label>
        <input type="text" id="repo" placeholder="owner/name" value="${escapeAttr(settings.github.repo)}" />
      </div>
      <div>
        <label for="branch">Branch</label>
        <input type="text" id="branch" placeholder="repro/&lt;date&gt;" value="${escapeAttr(settings.github.branch)}" />
      </div>
      <div>
        <label for="base-path">Path in repo</label>
        <input type="text" id="base-path" value="${escapeAttr(settings.github.basePath)}" />
      </div>
    </div>
    <label for="token">Fine-grained token (Contents: read and write)</label>
    <input type="password" id="token" autocomplete="off" placeholder="github_pat_..." />
    <div class="row">
      <button type="button" id="save-token">Save token on this device</button>
      <button type="button" id="forget-token">Forget token</button>
      <button type="button" id="check-token">Check access</button>
    </div>
    <p class="muted">Stored in this browser's IndexedDB. It is never written into the bundle.</p>
  </details>

  <div class="row" style="margin-top:1.25rem">
    <button class="primary" id="start" type="button" disabled>Process</button>
    <button id="cancel" type="button" disabled>Cancel</button>
  </div>

  <div id="progress" class="hidden">
    <p class="stage" id="stage">Starting</p>
    <div class="bar"><div id="bar-fill"></div></div>
  </div>

  <div id="notices"></div>
  <div id="result" class="hidden"></div>
  `;
}

function bindSettings(root: HTMLElement, settings: Settings, save: () => void): void {
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const bind = (el: HTMLElement, event: string, apply: () => void) =>
    el.addEventListener(event, () => {
      apply();
      save();
    });

  const transcribe = $<HTMLInputElement>("transcribe");
  const model = $<HTMLSelectElement>("model");
  const interval = $<HTMLInputElement>("interval");
  const cap = $<HTMLInputElement>("cap");
  const threshold = $<HTMLInputElement>("threshold");
  const includeUa = $<HTMLInputElement>("include-ua");
  const repo = $<HTMLInputElement>("repo");
  const branch = $<HTMLInputElement>("branch");
  const basePath = $<HTMLInputElement>("base-path");
  const token = $<HTMLInputElement>("token");
  const notices = $("notices");

  bind(transcribe, "change", () => (settings.transcribe = transcribe.checked));
  bind(model, "change", () => (settings.model = model.value as Settings["model"]));
  bind(interval, "change", () => (settings.frameIntervalSec = numberOr(interval.value, DEFAULT_SETTINGS.frameIntervalSec)));
  bind(cap, "change", () => (settings.frameCap = Math.max(2, Math.round(numberOr(cap.value, DEFAULT_SETTINGS.frameCap)))));
  bind(threshold, "change", () => (settings.sceneThreshold = numberOr(threshold.value, DEFAULT_SETTINGS.sceneThreshold)));
  bind(includeUa, "change", () => (settings.includeUserAgent = includeUa.checked));
  bind(repo, "change", () => (settings.github.repo = repo.value.trim()));
  bind(branch, "change", () => (settings.github.branch = branch.value.trim()));
  bind(basePath, "change", () => (settings.github.basePath = basePath.value.trim()));

  $("save-token").addEventListener("click", async () => {
    if (!token.value.trim()) return;
    await set(KEYS.githubToken, token.value.trim());
    token.value = "";
    addNotice(notices, "warn", "Token saved on this device.");
  });

  $("forget-token").addEventListener("click", async () => {
    await del(KEYS.githubToken);
    token.value = "";
    addNotice(notices, "warn", "Token removed from this device.");
  });

  $("check-token").addEventListener("click", async () => {
    const stored = token.value.trim() || (await get<string>(KEYS.githubToken));
    if (!stored) {
      addNotice(notices, "error", "No token saved yet.");
      return;
    }
    try {
      const info = await verifyAccess({ repo: settings.github.repo, token: stored });
      addNotice(notices, "warn", `Access confirmed. Default branch: ${info.defaultBranch}.`);
    } catch (err) {
      addNotice(notices, "error", err instanceof GithubError ? err.message : String(err));
    }
  });
}

function renderResult(
  box: HTMLElement,
  result: RunResult,
  settings: Settings,
  notices: HTMLElement,
  elapsedSec: string,
): void {
  box.classList.remove("hidden");
  box.replaceChildren();
  box.insertAdjacentHTML(
    "beforeend",
    `<h2>${result.folder}</h2>
     <p class="muted">${result.frameCount} frames · ${result.segmentCount} narration segments ·
     ${formatBytes(result.blob.size)} · ${elapsedSec}s</p>
     <div class="row">
       <button class="primary" id="download">Download ZIP</button>
       <button id="share-zip" class="hidden">Share</button>
       <button id="commit" class="hidden">Commit to GitHub</button>
     </div>
     <p class="muted">Unzip into your repository, then tell Claude Code:</p>
     <pre id="prompt">Read ${result.folder}/README.md and follow it.</pre>`,
  );

  const zipFile = zipAsFile(result.blob, result.fileName);
  box.querySelector<HTMLButtonElement>("#download")!.addEventListener("click", () =>
    downloadBlob(result.blob, result.fileName),
  );

  const shareBtn = box.querySelector<HTMLButtonElement>("#share-zip")!;
  if (canShareFile(zipFile)) {
    shareBtn.classList.remove("hidden");
    shareBtn.addEventListener("click", async () => {
      try {
        await shareFile(zipFile, result.folder);
      } catch (err) {
        addNotice(notices, "error", `Sharing failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  const commitBtn = box.querySelector<HTMLButtonElement>("#commit")!;
  if (settings.github.repo) {
    commitBtn.classList.remove("hidden");
    commitBtn.addEventListener("click", async () => {
      const token = await get<string>(KEYS.githubToken);
      if (!token) {
        addNotice(notices, "error", "Save a GitHub token in Settings first.");
        return;
      }
      commitBtn.disabled = true;
      try {
        const commit = await commitBundle(
          {
            repo: settings.github.repo,
            branch: settings.github.branch || defaultBranchName(result.folder),
            basePath: settings.github.basePath,
            token,
          },
          result.files,
          result.folder,
          (step, done, total) => {
            commitBtn.textContent = `${step} (${done}/${total})`;
          },
        );
        box.insertAdjacentHTML(
          "beforeend",
          `<p>Pushed to <a href="${commit.branchUrl}" target="_blank" rel="noopener">${commit.branch}</a>.</p>
           <p class="muted">Paste this into a Claude Code cloud session on that branch:</p>
           <pre>${commit.prompt}</pre>`,
        );
      } catch (err) {
        addNotice(notices, "error", err instanceof Error ? err.message : String(err));
      } finally {
        commitBtn.disabled = false;
        commitBtn.textContent = "Commit to GitHub";
      }
    });
  }
}

/** An error notice that also carries the evidence behind it. */
function addDiagnosis(host: HTMLElement, diagnosis: Diagnosis): void {
  const el = document.createElement("div");
  el.className = "notice error";

  const summary = document.createElement("p");
  summary.style.margin = "0";
  summary.textContent = diagnosis.summary;
  el.appendChild(summary);

  if (diagnosis.advice) {
    const advice = document.createElement("p");
    advice.style.margin = ".5rem 0 0";
    advice.textContent = diagnosis.advice;
    el.appendChild(advice);
  }

  const text = formatDiagnostics(diagnosis);
  const details = document.createElement("details");
  details.style.marginTop = ".5rem";
  const label = document.createElement("summary");
  label.textContent = "Details";
  details.appendChild(label);
  const pre = document.createElement("pre");
  pre.textContent = text;
  details.appendChild(pre);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy details";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
    } catch {
      // Clipboard access can be refused; the text is on screen either way.
      copy.textContent = "Select the text above to copy it";
    }
  });
  details.appendChild(copy);

  el.appendChild(details);
  host.appendChild(el);
}

function addNotice(host: HTMLElement, kind: "warn" | "error", message: string): void {
  const el = document.createElement("div");
  el.className = `notice ${kind}`;
  el.textContent = message;
  host.appendChild(el);
}

async function loadSettings(): Promise<Settings> {
  try {
    const stored = await get<Partial<Settings>>(KEYS.settings);
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      github: { ...DEFAULT_SETTINGS.github, ...(stored?.github ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS, github: { ...DEFAULT_SETTINGS.github } };
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  try {
    await set(KEYS.settings, settings);
  } catch {
    // Private browsing can refuse IndexedDB; settings simply do not persist.
  }
}

function numberOr(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
