import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LocalSource, approxTokens, collectMessages, msgSummary, parseRange } from "../src";

const FIX = join(import.meta.dir, "fixtures", "2.1.267");
const A = "aaaaaaaa-0000-4000-8000-000000000001";

describe("collectMessages", () => {
  test("one message per user/assistant record in file order; isMeta and non-conversation records skipped", async () => {
    const src = new LocalSource({ projectsDir: FIX });
    const msgs = await collectMessages(src.readSession(A));
    expect(msgs.map((m) => [m.index, m.role, m.uuid, m.isToolResult])).toEqual([
      [0, "user", "u1", false],
      [1, "assistant", "a1a", false],
      [2, "assistant", "a1", false],
      [3, "user", "u2", true],
      [4, "assistant", "a2", false],
      [5, "assistant", "a3", false],
    ]);
    expect(msgs[0]!.text).toBe("list the files");
    expect(msgs[0]!.ts).toBe("2026-09-01T00:00:00.000Z");
    expect(msgs[1]!.thinking).toEqual(["..."]);
    expect(msgs[2]!.tools).toEqual([{ name: "Bash", input: { command: "ls" } }]);
    expect(msgs[4]!.text).toBe("two files");
  });
});

describe("msgSummary", () => {
  test("text first, then tool names, then tool result, then (empty); whitespace collapsed; cut with an ellipsis", () => {
    const base = {
      index: 0,
      role: "assistant" as const,
      ts: null,
      uuid: null,
      thinking: [],
      tools: [],
      isToolResult: false,
    };
    expect(msgSummary({ ...base, text: "a\n\n b" })).toBe("a b");
    expect(
      msgSummary({
        ...base,
        text: "",
        tools: [
          { name: "Bash", input: {} },
          { name: "Read", input: {} },
        ],
      }),
    ).toBe("⚙ Bash, Read");
    expect(msgSummary({ ...base, role: "user", text: "", isToolResult: true })).toBe("(tool result)");
    expect(msgSummary({ ...base, text: "" })).toBe("(empty)");
    expect(msgSummary({ ...base, text: "abcdefghij" }, 5)).toBe("abcd…");
  });
});

describe("parseRange", () => {
  test("m3, 3, m3..m7, 3..7, reversed spans; junk is null", () => {
    expect(parseRange("m3")).toEqual({ start: 3, end: 3 });
    expect(parseRange("3")).toEqual({ start: 3, end: 3 });
    expect(parseRange("m3..m7")).toEqual({ start: 3, end: 7 });
    expect(parseRange("7..3")).toEqual({ start: 3, end: 7 });
    for (const bad of ["", "m", "x3", "3..", "..3", "1..2..3", "-1", "1.5"]) expect(parseRange(bad)).toBeNull();
  });

  test("approxTokens is chars / 4 rounded up", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("abcde")).toBe(2);
  });
});
