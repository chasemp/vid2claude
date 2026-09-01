/**
 * Commits a bundle straight to a GitHub repository from the browser.
 *
 * Uses the Git Data API (blobs -> tree -> commit -> ref) so the whole bundle
 * lands as one commit rather than one commit per frame. Endpoint shapes were
 * checked against docs.github.com and against a live CORS preflight; see
 * assumption A4 in docs/spikes.md.
 *
 * The token never leaves this module except as an Authorization header to
 * api.github.com, and is never written into the bundle or the console.
 */

import type { ZipEntry } from "../bundle/zip";

const API = "https://api.github.com";

export interface CommitTarget {
  /** "owner/name" */
  repo: string;
  branch: string;
  /** Path prefix inside the repo, e.g. "repro/". */
  basePath: string;
  token: string;
}

export interface CommitProgress {
  (step: string, done: number, total: number): void;
}

export class GithubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GithubError";
  }
}

export function parseRepo(repo: string): { owner: string; name: string } {
  const cleaned = repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new GithubError(`Repository must look like "owner/name", got "${repo}".`);
  }
  return { owner: parts[0]!, name: parts[1]! };
}

export function defaultBranchName(folder: string): string {
  return `repro/${folder.replace(/^repro-/, "")}`;
}

/** Joins the base path and bundle path without doubling or leading slashes. */
export function repoPath(basePath: string, entryPath: string): string {
  const base = basePath.replace(/^\/+/, "").replace(/\/*$/, "");
  return base ? `${base}/${entryPath}` : entryPath;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  token: string;
}

async function request<T>(path: string, opts: RequestOptions): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${opts.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (response.status === 404) {
    throw new GithubError(
      "GitHub returned 404. Check the repository name and that the token grants access to it.",
      404,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new GithubError(
      "GitHub rejected the token. A fine-grained token needs Contents: Read and write on this repository.",
      response.status,
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GithubError(`GitHub request failed (${response.status}): ${detail.slice(0, 300)}`, response.status);
  }
  return (await response.json()) as T;
}

export async function verifyAccess(target: Pick<CommitTarget, "repo" | "token">): Promise<{
  defaultBranch: string;
  permissions?: Record<string, boolean>;
}> {
  const { owner, name } = parseRepo(target.repo);
  const repo = await request<{ default_branch: string; permissions?: Record<string, boolean> }>(
    `/repos/${owner}/${name}`,
    { token: target.token },
  );
  return { defaultBranch: repo.default_branch, permissions: repo.permissions };
}

async function getRefSha(
  owner: string,
  name: string,
  branch: string,
  token: string,
): Promise<string | null> {
  try {
    const ref = await request<{ object: { sha: string } }>(
      `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`,
      { token },
    );
    return ref.object.sha;
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) return null;
    throw err;
  }
}

export interface CommitResult {
  branch: string;
  commitSha: string;
  branchUrl: string;
  folderUrl: string;
  prompt: string;
}

/**
 * Creates the branch if it does not exist, then writes every bundle file in a
 * single commit on top of it.
 */
export async function commitBundle(
  target: CommitTarget,
  files: ZipEntry[],
  folder: string,
  onProgress: CommitProgress = () => {},
): Promise<CommitResult> {
  const { owner, name } = parseRepo(target.repo);
  const token = target.token;
  const branch = target.branch.trim() || defaultBranchName(folder);

  onProgress("checking repository", 0, files.length + 3);
  const repo = await request<{ default_branch: string }>(`/repos/${owner}/${name}`, { token });

  let parentSha = await getRefSha(owner, name, branch, token);
  let branchExisted = parentSha !== null;
  if (!parentSha) {
    const baseSha = await getRefSha(owner, name, repo.default_branch, token);
    if (!baseSha) {
      throw new GithubError(
        `Could not read the default branch (${repo.default_branch}) to branch from.`,
      );
    }
    parentSha = baseSha;
  }

  const baseCommit = await request<{ tree: { sha: string } }>(
    `/repos/${owner}/${name}/git/commits/${parentSha}`,
    { token },
  );

  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (let i = 0; i < files.length; i++) {
    const entry = files[i]!;
    onProgress(`uploading ${entry.path}`, i, files.length + 3);
    const blob = await request<{ sha: string }>(`/repos/${owner}/${name}/git/blobs`, {
      method: "POST",
      token,
      body: { content: toBase64(entry.bytes), encoding: "base64" },
    });
    tree.push({
      path: repoPath(target.basePath, entry.path),
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }

  onProgress("building tree", files.length, files.length + 3);
  const newTree = await request<{ sha: string }>(`/repos/${owner}/${name}/git/trees`, {
    method: "POST",
    token,
    body: { base_tree: baseCommit.tree.sha, tree },
  });

  onProgress("creating commit", files.length + 1, files.length + 3);
  const commit = await request<{ sha: string }>(`/repos/${owner}/${name}/git/commits`, {
    method: "POST",
    token,
    body: {
      message: `Add reproduction bundle ${folder}`,
      tree: newTree.sha,
      parents: [parentSha],
    },
  });

  onProgress("updating branch", files.length + 2, files.length + 3);
  if (branchExisted) {
    await request(`/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      token,
      body: { sha: commit.sha, force: false },
    });
  } else {
    await request(`/repos/${owner}/${name}/git/refs`, {
      method: "POST",
      token,
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    });
  }

  const folderPath = repoPath(target.basePath, folder);
  return {
    branch,
    commitSha: commit.sha,
    branchUrl: `https://github.com/${owner}/${name}/tree/${encodeURIComponent(branch)}`,
    folderUrl: `https://github.com/${owner}/${name}/tree/${encodeURIComponent(branch)}/${folderPath}`,
    prompt: `Read ${folderPath}/README.md and follow it.`,
  };
}

/** base64 without blowing the call stack on a multi-megabyte PNG. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
