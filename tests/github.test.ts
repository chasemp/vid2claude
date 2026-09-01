import { describe, expect, it } from "vitest";
import { defaultBranchName, parseRepo, repoPath, toBase64, GithubError } from "../src/export/github";

describe("parseRepo", () => {
  it("accepts owner/name", () => {
    expect(parseRepo("chasemp/vid2claude")).toEqual({ owner: "chasemp", name: "vid2claude" });
  });

  it("accepts a pasted GitHub URL", () => {
    expect(parseRepo("https://github.com/chasemp/vid2claude.git")).toEqual({
      owner: "chasemp",
      name: "vid2claude",
    });
  });

  it("rejects anything else", () => {
    expect(() => parseRepo("vid2claude")).toThrow(GithubError);
    expect(() => parseRepo("a/b/c")).toThrow(GithubError);
  });
});

describe("repoPath", () => {
  it("joins the base path without doubling slashes", () => {
    expect(repoPath("repro/", "repro-2026-08-31-1412/README.md")).toBe(
      "repro/repro-2026-08-31-1412/README.md",
    );
    expect(repoPath("/repro", "x.md")).toBe("repro/x.md");
    expect(repoPath("", "x.md")).toBe("x.md");
  });
});

describe("defaultBranchName", () => {
  it("derives the branch from the bundle folder", () => {
    expect(defaultBranchName("repro-2026-08-31-1412")).toBe("repro/2026-08-31-1412");
  });
});

describe("toBase64", () => {
  it("encodes bytes the way the blobs endpoint expects", () => {
    expect(toBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
  });

  it("handles a payload larger than the call-stack chunk size", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).fill(7);
    const encoded = toBase64(bytes);
    expect(Buffer.from(encoded, "base64").length).toBe(bytes.length);
  });
});
