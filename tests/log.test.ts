import { describe, expect, it } from "vitest";
import { Logger, redact } from "../src/log";

function fixedClock() {
  let t = 0;
  return () => (t += 1000);
}

describe("redact", () => {
  it("removes GitHub tokens in any of their shapes", () => {
    expect(redact("token ghp_abcdefghij1234567890")).toContain("[redacted");
    expect(redact("using github_pat_11ABCDEFG_xyz1234567890")).toContain("[redacted-token]");
    expect(redact("Authorization: Bearer sk-abcdefghijklmnop")).toBe("Authorization: Bearer [redacted]");
  });

  it("leaves ordinary text alone", () => {
    const text = "seek to 12.5s failed with media error 3";
    expect(redact(text)).toBe(text);
  });
});

describe("Logger", () => {
  it("records level, scope, message and data", () => {
    const log = new Logger({ now: fixedClock() });
    log.info("video", "loaded", { width: 960, height: 2142 });
    const [entry] = log.toEntries();
    expect(entry).toMatchObject({ level: "info", scope: "video", message: "loaded" });
    expect(entry!.data).toEqual({ width: 960, height: 2142 });
  });

  it("scrubs secrets out of messages and data, however they are nested", () => {
    const log = new Logger({ now: fixedClock() });
    log.info("github", "pushing with ghp_abcdefghij1234567890", {
      token: "ghp_abcdefghij1234567890",
      nested: { authorization: "Bearer abcdefghijklmnop", note: "ghp_abcdefghij1234567890" },
    });
    const text = log.toText();
    expect(text).not.toContain("ghp_abcdefghij1234567890");
    expect(text).not.toContain("abcdefghijklmnop");
  });

  it("keeps entries below the minimum level out", () => {
    const log = new Logger({ minLevel: "info", now: fixedClock() });
    log.trace("scan", "sample");
    log.debug("scan", "sample");
    log.warn("scan", "slow");
    expect(log.toEntries().map((e) => e.level)).toEqual(["warn"]);
  });

  it("stays bounded, and says how much it dropped", () => {
    const log = new Logger({ capacity: 10, now: fixedClock() });
    for (let i = 0; i < 40; i++) log.info("scan", `sample ${i}`);
    expect(log.size).toBeLessThanOrEqual(10);
    expect(log.droppedCount).toBe(30);
    expect(log.toText()).toContain("entries dropped");
  });

  it("keeps the earliest entries, where the first failure is", () => {
    const log = new Logger({ capacity: 10, now: fixedClock() });
    log.error("open", "the first thing that went wrong");
    for (let i = 0; i < 40; i++) log.info("scan", `sample ${i}`);
    expect(log.toText()).toContain("the first thing that went wrong");
  });

  it("unpacks an Error, including a MediaError code and context", () => {
    const log = new Logger({ now: fixedClock() });
    const err = Object.assign(new Error("decoder gave up"), {
      name: "VideoSeekError",
      mediaError: { code: 3 } as MediaError,
      context: { timeSec: 12.5, readyState: 1 },
    });
    log.failure("capture", "frame failed", err, { timeSec: 12.5 });
    const [entry] = log.toEntries();
    expect(entry!.data).toMatchObject({
      errorName: "VideoSeekError",
      errorMessage: "decoder gave up",
      mediaErrorCode: 3,
      errorContext: { timeSec: 12.5, readyState: 1 },
    });
  });

  it("records a non-Error throw rather than losing it", () => {
    const log = new Logger({ now: fixedClock() });
    log.failure("capture", "odd throw", "just a string");
    expect(log.toEntries()[0]!.data).toMatchObject({ error: "just a string" });
  });

  it("formats one greppable line per entry, with a timestamp", () => {
    const log = new Logger({ now: fixedClock() });
    log.info("run", "started", { frames: 19 });
    expect(log.toText()).toMatch(/^\s+\d+\.\d{3}s INFO  run: started \{"frames":19\}\n$/);
  });

  it("gives a scoped view that does not repeat the scope", () => {
    const log = new Logger({ now: fixedClock() });
    const scoped = log.scoped("scan");
    scoped.warn("slow");
    expect(log.toEntries()[0]).toMatchObject({ scope: "scan", level: "warn", message: "slow" });
  });
});
