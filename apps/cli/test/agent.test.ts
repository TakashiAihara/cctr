import { describe, expect, test } from "bun:test";
import { isLocalBind, probeHost } from "../src/commands/agent";

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

import { isLoopbackUrl } from "../src/commands/remote";

describe("isLoopbackUrl", () => {
  test("literal loopback only; a hostname starting with 127. is not loopback", () => {
    expect(isLoopbackUrl("http://127.0.0.1:7411")).toBe(true);
    expect(isLoopbackUrl("http://127.1.2.3:7411")).toBe(true);
    expect(isLoopbackUrl("http://localhost:7411")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:7411")).toBe(true);
    expect(isLoopbackUrl("http://127.attacker.example:7411")).toBe(false);
    expect(isLoopbackUrl("http://192.168.0.5:7411")).toBe(false);
  });
});

describe("isLocalBind", () => {
  const ifaces = {
    eth0: [
      { address: "192.168.0.121", family: "IPv4" },
      { address: "fe80::1%eth0", family: "IPv6" },
    ],
  } as never;
  test("wildcards, loopback and this machine's addresses pass; names and other addresses do not", () => {
    for (const b of ["0.0.0.0", "::", "localhost", "::1", "127.0.0.1", "127.1.2.3", "192.168.0.121", "fe80::1"]) {
      expect(isLocalBind(b, ifaces)).toBe(true);
    }
    for (const b of ["example.com", "127.attacker.example", "10.0.0.9", "203.0.113.1", ""]) {
      expect(isLocalBind(b, ifaces)).toBe(false);
    }
  });
});
