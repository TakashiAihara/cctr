import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FetchLike, HttpSource, LocalSource, RemoteError } from "@cctr/core";
import { Code } from "@connectrpc/connect";
import { createApp } from "../src";

const FIX = join(import.meta.dir, "..", "..", "core", "test", "fixtures", "2.1.267");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const GOOD = "fixture-good-value";
const BAD = "fixture-bad-value";

const app = createApp({ source: new LocalSource({ projectsDir: FIX, host: "fx", version: "1.2.3" }), token: GOOD });
// route requests straight into the Hono app: no port, no network
const fetchApp: FetchLike = async (input, init) => app.fetch(new Request(input, init));
const bearer = (v: string) => ({ authorization: `Bearer ${v}` });
const SVC = "http://x/cctr.v1.TranscriptService";
const post = (proc: string, headers: Record<string, string>) =>
  app.fetch(
    new Request(`${SVC}/${proc}`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", ...headers },
    }),
  );

describe("agent app", () => {
  test("rejects a missing or wrong token on every procedure", async () => {
    for (const proc of ["GetMeta", "ListSessions", "GetSession", "ReadRecords"]) {
      expect((await post(proc, {})).status).toBe(401);
      expect((await post(proc, bearer(BAD))).status).toBe(401);
    }
  });

  test("HttpSource round-trips meta, list, get, records through the app", async () => {
    const src = new HttpSource({ host: "remote-a", url: "http://x", token: GOOD, fetch: fetchApp });
    const meta = await src.meta();
    expect(meta.version).toBe("1.2.3");
    expect(meta.host).toBe("fx");
    const list = await src.listSessions({ limit: 5 });
    expect(list).toHaveLength(2);
    // the caller's name for the host wins over whatever the remote calls itself
    expect(list.every((m) => m.host === "remote-a")).toBe(true);
    const one = await src.getSession(A);
    expect(one?.title).toBe("List files in proj-a");
    expect(one?.usage).toEqual({ input: 15, output: 23, cacheRead: 100, cacheCreate: 5 });
    expect(one?.tools).toEqual({ Bash: 1 });
    expect(one?.lastTs).toBe("2026-09-01T00:00:12.000Z");
    expect(one?.cwd).toBe("/home/u/proj-a");
    expect(await src.getSession("nope")).toBeNull();
    const types: string[] = [];
    for await (const r of src.readSession(A)) types.push(r.type);
    expect(types).toHaveLength(11);
    let n = 0;
    for await (const _ of src.readSession("nope")) n++;
    expect(n).toBe(0);
  });

  test("since and cwd reach the source through the request", async () => {
    const src = new HttpSource({ host: "remote-a", url: "http://x", token: GOOD, fetch: fetchApp });
    expect((await src.listSessions({ cwd: "/home/u/proj-b" })).map((m) => m.id)).toEqual([
      "bbbbbbbb-0000-4000-8000-000000000002",
    ]);
    expect((await src.listSessions({ since: "2026-08-25T00:00:00Z" })).map((m) => m.id)).toEqual([A]);
  });

  test("GetMeta carries the serving pid and a short token is refused at construction", async () => {
    const res = await post("GetMeta", bearer(GOOD));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pid: number }).pid).toBe(process.pid);
    expect(() => createApp({ source: new LocalSource({ projectsDir: FIX }), token: "" })).toThrow(/16/);
    expect(() => createApp({ source: new LocalSource({ projectsDir: FIX }), token: "short" })).toThrow(/16/);
  });

  test("auth failure surfaces as RemoteError naming the host, with the Connect code", async () => {
    const wrong = new HttpSource({ host: "remote-a", url: "http://x", token: BAD, fetch: fetchApp });
    await expect(wrong.meta()).rejects.toBeInstanceOf(RemoteError);
    await expect(wrong.meta()).rejects.toThrow(/^remote-a: /);
    const err = await wrong.meta().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).code).toBe(Code.Unauthenticated);
  });
});
