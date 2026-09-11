import { describe, expect, test } from "bun:test";
import { probeHost } from "../src/commands/agent";

describe("probeHost", () => {
  test("wildcards become loopback, IPv6 literals get brackets, IPv4 and names pass", () => {
    expect(probeHost("0.0.0.0")).toBe("127.0.0.1");
    expect(probeHost("::")).toBe("127.0.0.1");
    expect(probeHost("::1")).toBe("[::1]");
    expect(probeHost("fe80::1")).toBe("[fe80::1]");
    expect(probeHost("127.0.0.1")).toBe("127.0.0.1");
    expect(probeHost("localhost")).toBe("localhost");
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostToken, loadRemotes, saveRemotes } from "../src/config";

describe("hostToken", () => {
  test("an empty token file is refused, not regenerated and not looped on", () => {
    const dir = mkdtempSync(join(tmpdir(), "cctr-tok-"));
    process.env.CCTR_STATE_DIR = dir;
    writeFileSync(join(dir, "token"), "");
    expect(() => hostToken()).toThrow(/too short/);
    writeFileSync(join(dir, "token"), "short\n");
    expect(() => hostToken()).toThrow(/too short/);
    delete process.env.CCTR_STATE_DIR;
  });

  test("a fresh state dir gets one token and returns the same one after", () => {
    const dir = mkdtempSync(join(tmpdir(), "cctr-tok-"));
    process.env.CCTR_STATE_DIR = dir;
    const a = hostToken();
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(hostToken()).toBe(a);
    delete process.env.CCTR_STATE_DIR;
  });
});

describe("remotes", () => {
  test("a remote named like an Object.prototype member does not resolve to the prototype", () => {
    const dir = mkdtempSync(join(tmpdir(), "cctr-rem-"));
    const path = join(dir, "remotes.json");
    saveRemotes({ pi: { kind: "ssh", target: "pi" } }, path);
    const r = loadRemotes(path);
    expect(r.toString).toBeUndefined();
    expect(r.constructor).toBeUndefined();
    expect(r.pi?.kind).toBe("ssh");
  });
});
