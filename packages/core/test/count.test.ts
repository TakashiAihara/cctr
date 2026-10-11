import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSource, MultiSource, type Source } from "../src";

const tmp = mkdtempSync(join(tmpdir(), "cctr-count-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const rec = (o: object) => JSON.stringify(o) + "\n";
const tool = (uuid: string, ts: string, name: string, input: unknown) =>
  rec({
    type: "assistant",
    uuid,
    timestamp: ts,
    message: { role: "assistant", id: `m-${uuid}`, content: [{ type: "tool_use", id: uuid, name, input }] },
  });
const user = (uuid: string, ts: string, content: unknown, cwd = "/w/a") =>
  rec({ type: "user", uuid, timestamp: ts, cwd, message: { role: "user", content } });

export function corpus(): string {
  const dir = join(tmp, `p-${Math.random().toString(36).slice(2)}`);
  const write = (proj: string, id: string, body: string, mtime: number) => {
    mkdirSync(join(dir, proj), { recursive: true });
    const f = join(dir, proj, `${id}.jsonl`);
    writeFileSync(f, body);
    utimesSync(f, mtime, mtime);
  };
  write(
    "-w-a",
    "11111111-0000-4000-8000-000000000001",
    user("u1", "2026-09-01T09:10:00Z", "<command-name>/review</command-name> go") +
      tool("t1", "2026-09-01T09:11:00Z", "Bash", { command: "FOO=1 git status\necho hi" }) +
      tool("t2", "2026-09-01T09:12:00Z", "Bash", { command: "git log" }) +
      tool("t3", "2026-09-01T10:00:00Z", "Edit", { file_path: "/w/a/x.ts", old_string: "a", new_string: "b" }) +
      tool("t4", "2026-09-01T10:01:00Z", "Write", { file_path: "/w/a/x.ts", content: "c" }) +
      tool("t5", "2026-09-01T10:02:00Z", "NotebookEdit", { notebook_path: "/w/a/n.ipynb" }) +
      tool("t6", "2026-09-01T10:03:00Z", "Skill", { skill: "tdd" }) +
      tool("t7", "2026-09-01T10:04:00Z", "Skill", {}),
    3_000_000_000,
  );
  write(
    "-w-b",
    "22222222-0000-4000-8000-000000000002",
    user("u1", "2026-08-01T23:00:00Z", [{ type: "text", text: "<command-name>clear</command-name>" }], "/w/b") +
      tool("t1", "2026-08-01T23:30:00Z", "Bash", { command: "ls -la" }) +
      tool("t2", "2026-08-01T23:40:00Z", "Skill", { skill: "/tdd" }),
    2_000_000_000,
  );
  return dir;
}

describe("LocalSource.count", () => {
  const src = new LocalSource({ projectsDir: corpus(), host: "fx" });

  test("bash: leading word, env prefixes skipped; bash-full: the whole trimmed command", async () => {
    expect((await src.count({ kind: "bash" })).counts).toEqual({ git: 2, ls: 1 });
    expect((await src.count({ kind: "bash-full" })).counts).toEqual({
      "FOO=1 git status\necho hi": 1,
      "git log": 1,
      "ls -la": 1,
    });
  });

  test("files: Edit / Write / MultiEdit / NotebookEdit paths", async () => {
    expect((await src.count({ kind: "files" })).counts).toEqual({ "/w/a/x.ts": 2, "/w/a/n.ipynb": 1 });
  });

  test("slash: typed /commands, leading slash stripped; skill: Skill tool_use input.skill, ? when missing", async () => {
    expect((await src.count({ kind: "slash" })).counts).toEqual({ review: 1, clear: 1 });
    expect((await src.count({ kind: "skill" })).counts).toEqual({ tdd: 2, "?": 1 });
  });

  test("hour: records per UTC hour bucket; sessions, records and activeMs from the same pass", async () => {
    const r = await src.count({ kind: "hour" });
    expect(r.counts).toEqual({ "2026-09-01T09": 3, "2026-09-01T10": 5, "2026-08-01T23": 3 });
    expect(r.sessions).toBe(2);
    expect(r.records).toBe(11);
    // 54 min in the first session + 40 min in the second
    expect(r.activeMs).toBe(94 * 60_000);
  });

  test("cwd and since filter like listSessions", async () => {
    expect((await src.count({ kind: "bash", cwd: "/w/b" })).counts).toEqual({ ls: 1 });
    expect((await src.count({ kind: "bash", since: "2026-08-15T00:00:00Z" })).counts).toEqual({ git: 2 });
  });

  test("an unknown kind is an error", async () => {
    await expect(src.count({ kind: "nope" as "bash" })).rejects.toThrow(/unknown count kind/);
  });
});

describe("MultiSource.count", () => {
  test("sums counts and totals across hosts, reports the host that failed", async () => {
    const a = new LocalSource({ projectsDir: corpus(), host: "a" });
    const b = new LocalSource({ projectsDir: corpus(), host: "b" });
    const down = { host: "down", count: () => Promise.reject(new Error("down: unreachable")) } as unknown as Source;
    const { result, errors } = await new MultiSource([a, down, b]).count({ kind: "bash" });
    expect(result.counts).toEqual({ git: 4, ls: 2 });
    expect(result.sessions).toBe(4);
    expect(errors).toEqual([{ host: "down", error: "unreachable" }]);
  });
});
