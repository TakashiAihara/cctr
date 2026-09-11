import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LocalSource, listSessionFiles, parseLine } from "../src";

const FIX = join(import.meta.dir, "fixtures", "2.1.267");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

describe("listSessionFiles", () => {
  test("lists only top-level session files, newest first", () => {
    const files = listSessionFiles(FIX).map((f) => f.file);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.includes("subagents"))).toBe(false);
  });
  test("missing dir is empty, not an error", () => {
    expect(listSessionFiles(join(FIX, "nope"))).toEqual([]);
  });
});

describe("parseLine", () => {
  test("keeps unknown record types with their raw payload", () => {
    const r = parseLine('{"type":"unknown-future-record","payload":{"x":1}}');
    expect(r?.type).toBe("unknown-future-record");
    expect((r!.raw as { payload: { x: number } }).payload.x).toBe(1);
  });
  test("rejects a half-written line and a line without type", () => {
    expect(parseLine('{"broken')).toBeNull();
    expect(parseLine('{"uuid":"x"}')).toBeNull();
    expect(parseLine("")).toBeNull();
  });
});

describe("LocalSource", () => {
  const src = new LocalSource({ projectsDir: FIX, host: "fixture", version: "9.9.9" });

  test("meta describes the source", async () => {
    const m = await src.meta();
    expect(m.name).toBe("cctr");
    expect(m.version).toBe("9.9.9");
    expect(m.host).toBe("fixture");
    expect(m.projectsDir).toBe(FIX);
  });

  test("session A aggregates in one pass", async () => {
    const m = await src.getSession(A);
    expect(m).not.toBeNull();
    expect(m!.host).toBe("fixture");
    expect(m!.cwd).toBe("/home/u/proj-a");
    expect(m!.gitBranch).toBe("main");
    expect(m!.version).toBe("2.1.267");
    expect(m!.title).toBe("List files in proj-a");
    expect(m!.lastPrompt).toBe("list the files");
    // tool_result-only and isMeta user records are not prompts
    expect(m!.userTurns).toBe(1);
    // msg_1 is written as 2 lines: one API message, counted and summed once (last line wins)
    // the <synthetic> message has no id: counted as a message but not as a model
    expect(m!.assistantMsgs).toBe(3);
    expect(m!.models).toEqual(["claude-opus-5"]);
    expect(m!.usage).toEqual({ input: 15, output: 23, cacheRead: 100, cacheCreate: 5 });
    expect(m!.tools).toEqual({ Bash: 1 });
    expect(m!.firstTs).toBe("2026-09-01T00:00:00.000Z");
    expect(m!.lastTs).toBe("2026-09-01T00:00:12.000Z");
    expect(m!.durationMs).toBe(12000);
    // the unknown record and the broken trailing line: counted / skipped
    expect(m!.records).toBe(11);
  });

  test("an unparseable timestamp gives duration 0, not NaN", async () => {
    const { parseSession } = await import("../src");
    const { writeFileSync, mkdtempSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "cctr-ts-"));
    mkdirSync(join(dir, "p"));
    const f = join(dir, "p", "cccccccc-0000-4000-8000-000000000003.jsonl");
    writeFileSync(
      f,
      '{"type":"user","timestamp":"not a date","message":{"role":"user","content":"x"},"uuid":"u1"}\n' +
        '{"type":"assistant","timestamp":"2026-09-01T00:00:01.000Z","message":{"id":"m","role":"assistant","content":[]},"uuid":"a1"}\n',
    );
    const m = await parseSession({ file: f, mtimeMs: 0, sizeBytes: 0 });
    expect(m.durationMs).toBe(0);
    expect(Number.isFinite(m.durationMs)).toBe(true);
  });

  test("prefix and latest resolve", async () => {
    expect((await src.getSession("bbbb"))?.id).toBe(B);
    expect(await src.getSession("zzzz")).toBeNull();
    // `latest` is the newest file; the ordering test in multi.test.ts pins which one that is
    const files = listSessionFiles(FIX);
    expect((await src.getSession("latest"))?.file).toBe(files[0]!.file);
  });

  test("listSessions filters by cwd, since, limit", async () => {
    expect((await src.listSessions()).map((m) => m.id).sort()).toEqual([A, B]);
    expect((await src.listSessions({ cwd: "/home/u/proj-b" })).map((m) => m.id)).toEqual([B]);
    expect((await src.listSessions({ since: "2026-08-25T00:00:00Z" })).map((m) => m.id)).toEqual([A]);
    expect(await src.listSessions({ limit: 1 })).toHaveLength(1);
  });

  test("readSession streams records and drops the broken tail", async () => {
    const types: string[] = [];
    for await (const r of src.readSession(A)) types.push(r.type);
    expect(types).toHaveLength(11);
    expect(types[0]).toBe("permission-mode");
    expect(types.at(-1)).toBe("user");
  });
});
