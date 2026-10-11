import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(import.meta.dir, "..", "..", "..", "packages", "core", "test", "fixtures", "2.1.267");
const CLI = join(import.meta.dir, "..", "src", "index.ts");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const tmp = mkdtempSync(join(tmpdir(), "cctr-read-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function cctr(args: string[]) {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    env: {
      ...process.env,
      CCTR_PROJECTS_DIR: FIX,
      CCTR_CONFIG_DIR: join(tmp, "config"),
      CCTR_STATE_DIR: join(tmp, "state"),
    },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("cctr show", () => {
  test("json: the session's metadata and its messages; thinking and tools only when asked", () => {
    const r = cctr(["show", "aaaa"]);
    expect(r.code).toBe(0);
    const o = JSON.parse(r.out) as {
      session: { id: string; title: string };
      messages: { index: string; role: string; text: string; thinking?: unknown; tools?: unknown }[];
    };
    expect(o.session.id).toBe(A);
    expect(o.session.title).toBe("List files in proj-a");
    expect(o.messages.map((m) => m.index)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5"]);
    expect(o.messages.every((m) => m.thinking === undefined && m.tools === undefined)).toBe(true);
    const full = JSON.parse(cctr(["show", "aaaa", "--tools", "--thinking"]).out) as typeof o;
    expect(full.messages[1]!.thinking).toEqual(["..."]);
    expect(full.messages[2]!.tools).toEqual([{ name: "Bash", input: { command: "ls" } }]);
  });

  test("table: a readable transcript; tool results hidden; tools and thinking on request", () => {
    const plain = cctr(["--format", "table", "show", "aaaa"]).out;
    expect(plain).toContain(A);
    expect(plain).toContain("▶ user\nlist the files");
    expect(plain).toContain("● assistant\ntwo files");
    expect(plain).not.toContain("⚙ Bash");
    expect(plain).not.toContain("a.ts");
    expect(plain).not.toContain("\x1b[");
    const full = cctr(["--format", "table", "show", "aaaa", "--tools", "--thinking"]).out;
    expect(full).toContain('⚙ Bash {"command":"ls"}');
    expect(full).toContain("~ thinking\n...");
  });

  test("unknown session is exit 3", () => {
    expect(cctr(["show", "nope"]).code).toBe(3);
  });
});

describe("cctr outline", () => {
  test("json: index, role, ts, tool names, summary", () => {
    const o = JSON.parse(cctr(["outline", A]).out) as {
      index: string;
      role: string;
      tools: string[];
      summary: string;
    }[];
    expect(o.map((m) => [m.index, m.role, m.tools, m.summary])).toEqual([
      ["m0", "user", [], "list the files"],
      ["m1", "assistant", [], "(empty)"],
      ["m2", "assistant", ["Bash"], "⚙ Bash"],
      ["m3", "user", [], "a.ts b.ts"],
      ["m4", "assistant", [], "two files"],
      ["m5", "assistant", [], "injected"],
    ]);
  });

  test("table: one line per message, cut by the token budget with a note", () => {
    const all = cctr(["--format", "table", "outline", A, "--no-budget"]).out.trimEnd().split("\n");
    expect(all).toHaveLength(6);
    expect(all[0]).toBe("m0\t▶ user\t2026-09-01 00:00\tlist the files");
    const cut = cctr(["--format", "table", "outline", A, "--budget", "20"]).out.trimEnd().split("\n");
    expect(cut.length).toBeLessThan(6);
    expect(cut.at(-1)).toMatch(/^… \(\d+ more messages; raise --budget or --no-budget\)$/);
    expect(cctr(["outline", A, "--budget", "0"]).code).toBe(2);
  });
});

describe("cctr read", () => {
  test("json: ranges select messages", () => {
    const r = JSON.parse(cctr(["read", A, "m0", "m3..m4"]).out) as {
      index: string;
      isToolResult: boolean;
      text: string;
    }[];
    expect(r.map((m) => [m.index, m.isToolResult])).toEqual([
      ["m0", false],
      ["m3", true],
      ["m4", false],
    ]);
  });

  test("table: tool results only with --tool-results", () => {
    const hidden = cctr(["--format", "table", "read", A, "m3"]).out;
    expect(hidden).toContain("── m3 user 2026-09-01 00:00:06 ──");
    expect(hidden).toContain("(tool result — pass --tool-results to show)");
  });

  test("an invalid range is exit 2; a range with no messages is exit 3", () => {
    const bad = cctr(["read", A, "junk"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/invalid range: junk/);
    expect(cctr(["read", A, "m99"]).code).toBe(3);
  });

  test("the budget cuts table output but always shows the first message", () => {
    const out = cctr(["--format", "table", "read", A, "--budget", "1"]).out;
    expect(out).toContain("── m0 user");
    expect(out).toMatch(/budget 1 reached; 5 more/);
  });
});
