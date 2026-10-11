import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalSource, MultiSource, type SearchQuery, type SessionHits, type Source } from "../src";

const tmp = mkdtempSync(join(tmpdir(), "cctr-search-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const S1 = "11111111-0000-4000-8000-000000000001";
const S2 = "22222222-0000-4000-8000-000000000002";
const S3 = "33333333-0000-4000-8000-000000000003";

function rec(o: object): string {
  return JSON.stringify(o) + "\n";
}

function user(id: string, uuid: string, ts: string, content: unknown, extra: object = {}) {
  return rec({
    type: "user",
    uuid,
    sessionId: id,
    timestamp: ts,
    cwd: `/w/${id.slice(0, 2)}`,
    message: { role: "user", content },
    ...extra,
  });
}

function asst(id: string, uuid: string, ts: string, content: unknown[]) {
  return rec({
    type: "assistant",
    uuid,
    sessionId: id,
    timestamp: ts,
    message: { role: "assistant", id: `m-${uuid}`, content },
  });
}

/** Three sessions; S1 newest by mtime, S3 oldest. */
function corpus(): string {
  const dir = join(tmp, `p-${Math.random().toString(36).slice(2)}`);
  const write = (proj: string, id: string, body: string, mtime: number) => {
    mkdirSync(join(dir, proj), { recursive: true });
    const f = join(dir, proj, `${id}.jsonl`);
    writeFileSync(f, body);
    utimesSync(f, mtime, mtime);
  };
  write(
    "-w-11",
    S1,
    user(S1, "u1", "2026-09-03T00:00:00Z", "please find the Needle in here") +
      asst(S1, "a1", "2026-09-03T00:00:01Z", [{ type: "thinking", thinking: "the needle is hidden in thought" }]) +
      asst(S1, "a2", "2026-09-03T00:00:02Z", [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "kaneo task create --body 'needle body'" } },
      ]) +
      user(S1, "u2", "2026-09-03T00:00:03Z", [
        { type: "tool_result", tool_use_id: "t1", content: "needle in a tool result" },
      ]) +
      asst(S1, "a3", "2026-09-03T00:00:04Z", [{ type: "text", text: "found one needle and another needle" }]) +
      user(S1, "u3", "2026-09-03T00:00:05Z", "<meta needle>", { isMeta: true }) +
      rec({ type: "ai-title", aiTitle: "needle hunt" }),
    3_000_000_000,
  );
  write(
    "-w-22",
    S2,
    user(S2, "u1", "2026-09-02T00:00:00Z", [{ type: "text", text: "NEEDLE upper" }]) +
      asst(S2, "a1", "2026-09-02T00:00:01Z", [
        { type: "text", text: "a" + "x".repeat(200) + "needle" + "y".repeat(200) + "z" },
      ]),
    2_000_000_000,
  );
  write(
    "-w-33",
    S3,
    user(S3, "u1", "2026-09-01T00:00:00Z", "nothing to see") +
      asst(S3, "a1", "2026-09-01T00:00:01Z", [{ type: "text", text: "nope" }]),
    1_000_000_000,
  );
  return dir;
}

async function all(src: Source, q: SearchQuery): Promise<SessionHits[]> {
  const out: SessionHits[] = [];
  for await (const s of src.search(q)) out.push(s);
  return out;
}

describe("LocalSource.search", () => {
  const src = new LocalSource({ projectsDir: corpus(), host: "fx" });

  test("substring, case-insensitive by default, user and assistant text only; newest session first", async () => {
    const res = await all(src, { query: "needle" });
    expect(res.map((r) => r.session.id)).toEqual([S1, S2]);
    expect(res[0]!.session.title).toBe("needle hunt");
    expect(res[0]!.session.host).toBe("fx");
    // u1 (prompt) and a3 (text); not thinking, not tool_use, not tool_result, not isMeta
    expect(res[0]!.hits.map((h) => [h.uuid, h.role, h.kind])).toEqual([
      ["u1", "user", "text"],
      ["a3", "assistant", "text"],
    ]);
    expect(res[0]!.total).toBe(2);
    expect(res[0]!.hits[0]!.ts).toBe("2026-09-03T00:00:00Z");
    expect(res[1]!.hits.map((h) => h.uuid)).toEqual(["u1", "a1"]);
  });

  test("--case makes it case-sensitive", async () => {
    const res = await all(src, { query: "NEEDLE", caseSensitive: true });
    expect(res.map((r) => [r.session.id, r.hits.map((h) => h.uuid)])).toEqual([[S2, ["u1"]]]);
  });

  test("--regex, honoring --case", async () => {
    expect((await all(src, { query: "ne+dle\\s+(in|upper)", regex: true })).map((r) => r.session.id)).toEqual([S1, S2]);
    expect((await all(src, { query: "Ne+dle", regex: true, caseSensitive: true })).map((r) => r.session.id)).toEqual([
      S1,
    ]);
  });

  test("an invalid regex is an error, not zero hits", async () => {
    await expect(all(src, { query: "(", regex: true })).rejects.toThrow();
  });

  test("--role narrows to one side", async () => {
    const res = await all(src, { query: "needle", role: "assistant" });
    expect(res.flatMap((r) => r.hits.map((h) => h.role))).toEqual(["assistant", "assistant"]);
  });

  test("--thinking and --tools add those blocks", async () => {
    const res = await all(src, { query: "needle", thinking: true, tools: true });
    expect(res[0]!.hits.map((h) => [h.uuid, h.kind])).toEqual([
      ["u1", "text"],
      ["a1", "thinking"],
      ["a2", "tool_use"],
      ["a3", "text"],
    ]);
    // the tool name leads the excerpt of a tool_use hit
    expect(res[0]!.hits[2]!.excerpt).toContain("Bash");
    expect(res[0]!.hits[2]!.excerpt).toContain("needle body");
  });

  test("the excerpt is the match with `context` chars either side, cut edges marked", async () => {
    const [, s2] = await all(src, { query: "needle", context: 10 });
    const ex = s2!.hits[1]!.excerpt;
    expect(ex).toBe("…xxxxxxxxxxneedleyyyyyyyyyy…");
    // a short block is whole, unmarked
    expect(s2!.hits[0]!.excerpt).toBe("NEEDLE upper");
  });

  test("hitsPerSession caps hits but total still counts every matching block", async () => {
    const [s1] = await all(src, { query: "needle", hitsPerSession: 1 });
    expect(s1!.hits).toHaveLength(1);
    expect(s1!.total).toBe(2);
  });

  test("limit caps sessions", async () => {
    expect((await all(src, { query: "needle", limit: 1 })).map((r) => r.session.id)).toEqual([S1]);
  });

  test("session pins one session (prefix ok); cwd and since filter", async () => {
    expect((await all(src, { query: "needle", session: "2222" })).map((r) => r.session.id)).toEqual([S2]);
    expect((await all(src, { query: "needle", cwd: "/w/22" })).map((r) => r.session.id)).toEqual([S2]);
    expect((await all(src, { query: "needle", since: "2026-09-02T12:00:00Z" })).map((r) => r.session.id)).toEqual([S1]);
  });
});

describe("MultiSource.search", () => {
  const a = new LocalSource({ projectsDir: corpus(), host: "a" });
  const down: Source = {
    host: "down",
    meta: () => Promise.reject(new Error("down: unreachable")),
    listSessions: () => Promise.reject(new Error("down: unreachable")),
    getSession: () => Promise.reject(new Error("down: unreachable")),
    async *readSession() {
      throw new Error("down: unreachable");
    },
    async *search() {
      throw new Error("down: unreachable");
    },
  };

  test("merges hosts by session lastTs, newest first, and reports the host that failed", async () => {
    const b = new LocalSource({ projectsDir: corpus(), host: "b" });
    const { results, errors } = await new MultiSource([a, down, b]).search({ query: "needle" });
    expect(results.map((r) => `${r.session.host}:${r.session.id.slice(0, 2)}`)).toEqual([
      "a:11",
      "b:11",
      "a:22",
      "b:22",
    ]);
    expect(errors).toEqual([{ host: "down", error: "unreachable" }]);
  });

  test("limit applies after merging", async () => {
    const b = new LocalSource({ projectsDir: corpus(), host: "b" });
    const { results } = await new MultiSource([a, b]).search({ query: "needle", limit: 3 });
    expect(results).toHaveLength(3);
  });

  test("a host:id session pins that host", async () => {
    const b = new LocalSource({ projectsDir: corpus(), host: "b" });
    const { results } = await new MultiSource([a, b]).search({ query: "needle", session: `b:${S2}` });
    expect(results.map((r) => `${r.session.host}:${r.session.id}`)).toEqual([`b:${S2}`]);
  });
});

describe("linePrefilter", () => {
  const { compileMatcher, linePrefilter } = require("../src") as typeof import("../src");

  test("no prefilter for a regex or a query JSON would escape", () => {
    expect(linePrefilter({ query: "a.b", regex: true })).toBeUndefined();
    expect(linePrefilter({ query: 'say "hi"' })).toBeUndefined();
    expect(linePrefilter({ query: "a\\b" })).toBeUndefined();
    expect(linePrefilter({ query: "x" })).toBeDefined();
  });

  test("never rules out a line whose text the matcher accepts", () => {
    const cases: [string, string, boolean?][] = [
      ["needle", "a NeEdLe here"],
      ["詳細は Kaneo", "x 詳細は kaneo y"],
      ["ärger", "ÄRGER"],
      ["i", "İstanbul"],
      ["#3 x", "#3 X"],
      ["needle", "NEEDLE", true],
    ];
    for (const [query, text, caseSensitive] of cases) {
      const q = { query, caseSensitive };
      const line = JSON.stringify({ type: "user", message: { content: text } });
      expect(!!compileMatcher(q)(text)).toBe(!caseSensitive);
      expect(linePrefilter(q)!(line)).toBe(!caseSensitive);
    }
  });

  test("rules out a line that cannot hold the query", () => {
    expect(linePrefilter({ query: "詳細は kaneo" })!('{"x":"詳細は other"}')).toBe(false);
    expect(linePrefilter({ query: "kaneo" })!('{"x":"other"}')).toBe(false);
  });

  test("a query with a quote still finds its block (no prefilter, full parse)", async () => {
    const dir = join(tmp, "quote", "-p");
    mkdirSync(dir, { recursive: true });
    const id = "44444444-0000-4000-8000-000000000004";
    writeFileSync(join(dir, `${id}.jsonl`), user(id, "u1", "2026-09-01T00:00:00Z", 'he said "stop" twice'));
    const src = new LocalSource({ projectsDir: join(tmp, "quote") });
    expect((await all(src, { query: 'said "stop"' })).map((r) => r.session.id)).toEqual([id]);
  });
});
