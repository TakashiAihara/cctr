import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostsUnreachableError,
  UnknownHostError,
  LocalSource,
  MultiSource,
  type Record,
  type SessionFilter,
  type SessionMeta,
  type Source,
  type SourceMeta,
  emptyUsage,
  lines,
  listSessionFiles,
  splitHost,
} from "../src";

const FIX = join(import.meta.dir, "fixtures", "2.1.267");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const FILE_A = join("-home-u-proj-a", `${A}.jsonl`);
const FILE_B = join("-home-u-proj-b", `${B}.jsonl`);

/** A private copy of the fixtures whose mtimes the test may set. */
function fixtureCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "cctr-fix-"));
  cpSync(FIX, dir, { recursive: true });
  return dir;
}

function meta(id: string, host: string, lastTs: string): SessionMeta {
  return {
    id,
    file: `/x/${id}.jsonl`,
    host,
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    title: null,
    lastPrompt: null,
    firstTs: null,
    lastTs,
    durationMs: 0,
    records: 0,
    userTurns: 0,
    assistantMsgs: 0,
    models: [],
    usage: emptyUsage(),
    tools: {},
    sizeBytes: 0,
    mtimeMs: 0,
  };
}

/** A Source that holds fixed sessions, or fails every call. */
function fake(host: string, sessions: SessionMeta[], fail?: string): Source {
  const boom = () => {
    throw new Error(`${host}: ${fail}`);
  };
  return {
    host,
    async meta(): Promise<SourceMeta> {
      if (fail) boom();
      return { name: "cctr", version: "0", schemaVersion: 1, host, projectsDir: "/x" };
    },
    async listSessions(_f?: SessionFilter) {
      if (fail) boom();
      return sessions;
    },
    async getSession(id: string) {
      if (fail) boom();
      return sessions.find((s) => s.id === id || s.id.startsWith(id)) ?? null;
    },
    async *readSession(id: string): AsyncGenerator<Record> {
      if (fail) boom();
      const s = sessions.find((s) => s.id === id);
      if (s) yield { type: "user", raw: { type: "user", from: host }, sessionId: s.id };
    },
  };
}

describe("discover order and latest", () => {
  test("files come newest mtime first and `latest` is the first", async () => {
    const dir = fixtureCopy();
    utimesSync(join(dir, FILE_A), new Date("2026-01-01"), new Date("2026-01-01"));
    utimesSync(join(dir, FILE_B), new Date("2026-02-01"), new Date("2026-02-01"));
    expect(listSessionFiles(dir).map((f) => f.file.endsWith(`${B}.jsonl`))).toEqual([true, false]);
    expect((await new LocalSource({ projectsDir: dir }).getSession("latest"))?.id).toBe(B);

    utimesSync(join(dir, FILE_A), new Date("2026-03-01"), new Date("2026-03-01"));
    expect(listSessionFiles(dir).map((f) => f.file.endsWith(`${A}.jsonl`))).toEqual([true, false]);
    expect((await new LocalSource({ projectsDir: dir }).getSession("latest"))?.id).toBe(A);
  });

  test("`since` stops at the first file whose mtime is older, without parsing it", async () => {
    const dir = fixtureCopy();
    // A's records are stamped 2026-09-01, but the file itself was last written before `since`:
    // by the documented assumption that cannot hold real records after `since`, so A is skipped
    utimesSync(join(dir, FILE_A), new Date("2026-08-01"), new Date("2026-08-01"));
    utimesSync(join(dir, FILE_B), new Date("2026-09-10"), new Date("2026-09-10"));
    const src = new LocalSource({ projectsDir: dir });
    expect((await src.listSessions({ since: "2026-08-25T00:00:00Z" })).map((m) => m.id)).toEqual([]);
    // within a day of `since` the file is still parsed, and its records decide
    utimesSync(join(dir, FILE_A), new Date("2026-08-24T12:00:00Z"), new Date("2026-08-24T12:00:00Z"));
    expect((await src.listSessions({ since: "2026-08-25T00:00:00Z" })).map((m) => m.id)).toEqual([A]);
    // and with the file freshly written, A comes back
    utimesSync(join(dir, FILE_A), new Date("2026-09-11"), new Date("2026-09-11"));
    expect((await src.listSessions({ since: "2026-08-25T00:00:00Z" })).map((m) => m.id)).toEqual([A]);
  });
});

describe("splitHost", () => {
  test("host:id splits, a bare id has no host, a leading colon is not a host", () => {
    expect(splitHost("pi:abc")).toEqual({ host: "pi", id: "abc" });
    expect(splitHost("abc")).toEqual({ host: null, id: "abc" });
    expect(splitHost(":abc")).toEqual({ host: null, id: ":abc" });
  });
});

describe("MultiSource", () => {
  const s1 = meta("s1", "one", "2026-09-01T00:00:00Z");
  const s2 = meta("s2", "two", "2026-09-02T00:00:00Z");
  const one = fake("one", [s1]);
  const two = fake("two", [s2]);
  const down = fake("down", [], "unreachable");

  test("listSessions merges newest first and reports the host that failed", async () => {
    const { sessions, errors } = await new MultiSource([one, down, two]).listSessions();
    expect(sessions.map((m) => m.id)).toEqual(["s2", "s1"]);
    expect(errors).toEqual([{ host: "down", error: "unreachable" }]);
    expect((await new MultiSource([one, two]).listSessions({ limit: 1 })).sessions.map((m) => m.id)).toEqual(["s2"]);
  });

  test("getSession skips a failed host when another has the session", async () => {
    const m = new MultiSource([down, two]);
    expect((await m.getSession("s2"))?.host).toBe("two");
    const got: unknown[] = [];
    for await (const r of m.readSession("s2")) got.push((r.raw as { from: string }).from);
    expect(got).toEqual(["two"]);
  });

  test("getSession raises when nobody has it and a host failed, and returns null when all answered", async () => {
    await expect(new MultiSource([down, two]).getSession("nope")).rejects.toBeInstanceOf(HostsUnreachableError);
    await expect(new MultiSource([down, two]).getSession("nope")).rejects.toThrow(/down: unreachable/);
    expect(await new MultiSource([one, two]).getSession("nope")).toBeNull();
  });

  test("host:id pins one host, even when another also has that id", async () => {
    const dup = fake("two", [meta("s1", "two", "2026-09-05T00:00:00Z")]);
    const m = new MultiSource([one, dup]);
    expect((await m.getSession("two:s1"))?.host).toBe("two");
    expect((await m.getSession("one:s1"))?.host).toBe("one");
    await expect(m.getSession("three:s1")).rejects.toBeInstanceOf(UnknownHostError);
  });
});

describe("MultiSource latest", () => {
  test("`latest` is the newest across hosts, not the first host that answered", async () => {
    const old = fake("one", [meta("s-old", "one", "2026-01-01T00:00:00Z")]);
    const recent = fake("two", [meta("s-new", "two", "2026-09-01T00:00:00Z")]);
    // fakes answer "latest" with their single session
    for (const f of [old, recent]) {
      const orig = f.getSession.bind(f);
      f.getSession = async (id) => (id === "latest" ? ((await f.listSessions())[0] ?? null) : orig(id));
    }
    expect((await new MultiSource([old, recent]).getSession("latest"))?.id).toBe("s-new");
    expect((await new MultiSource([recent, old]).getSession("latest"))?.id).toBe("s-new");
  });
});

describe("usage per message id", () => {
  test("a later line without usage keeps what the earlier line reported", async () => {
    const { parseSession } = await import("../src");
    const { writeFileSync, mkdtempSync, mkdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "cctr-usage-"));
    mkdirSync(join(dir, "p"));
    const f = join(dir, "p", "dddddddd-0000-4000-8000-000000000004.jsonl");
    writeFileSync(
      f,
      '{"type":"assistant","timestamp":"2026-09-01T00:00:00.000Z","message":{"id":"m","role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":7,"output_tokens":3}},"uuid":"a1"}\n' +
        '{"type":"assistant","timestamp":"2026-09-01T00:00:01.000Z","message":{"id":"m","role":"assistant","content":[{"type":"text","text":"b"}]},"uuid":"a2"}\n',
    );
    const m = await parseSession({ file: f, mtimeMs: 0, sizeBytes: 0 });
    expect(m.usage).toEqual({ input: 7, output: 3, cacheRead: 0, cacheCreate: 0 });
    expect(m.assistantMsgs).toBe(1);
  });
});

describe("ssh target and quoting", () => {
  test("targets starting with - or containing spaces are refused; ~ stays bare in quoting", async () => {
    const { isSshTarget, shellQuote, SshSource } = await import("../src");
    expect(isSshTarget("user@host")).toBe(true);
    expect(isSshTarget("pi")).toBe(true);
    expect(isSshTarget("-oProxyCommand=calc")).toBe(false);
    expect(isSshTarget("user@host extra")).toBe(false);
    expect(isSshTarget("")).toBe(false);
    expect(() => new SshSource({ host: "x", target: "-oProxyCommand=calc" })).toThrow(/not an ssh target/);
    expect(shellQuote("~/.local/bin/cctr")).toBe("~/.local/bin/cctr");
    expect(shellQuote("a b")).toBe("'a b'");
  });
});

describe("lines", () => {
  async function collect(chunks: string[]): Promise<string[]> {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(enc.encode(c));
        ctrl.close();
      },
    });
    const out: string[] = [];
    for await (const l of lines(body)) out.push(l);
    return out;
  }

  test("splits across chunk boundaries and drops an unterminated tail", async () => {
    expect(await collect(['{"a":1}\n{"b', '":2}\n{"c":3}'])).toEqual(['{"a":1}', '{"b":2}']);
    expect(await collect(['{"a":1}\n'])).toEqual(['{"a":1}']);
    expect(await collect([])).toEqual([]);
  });
});

describe("machineId", () => {
  test("CCX_MACHINE overrides the hostname; blank does not", async () => {
    const { machineId } = await import("../src");
    expect(machineId({ CCX_MACHINE: "fleet-a" })).toBe("fleet-a");
    expect(machineId({ CCX_MACHINE: "  " })).not.toBe("  ");
    expect(machineId({})).toBeString();
    const src = new LocalSource({ projectsDir: FIX });
    expect((await src.meta()).host).toBe(machineId());
  });
});
