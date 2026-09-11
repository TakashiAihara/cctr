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
