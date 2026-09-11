import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FetchLike, HttpSource, LocalSource, RemoteError } from "@cctr/core";
import { createApp } from "../src";

const FIX = join(import.meta.dir, "..", "..", "core", "test", "fixtures", "2.1.267");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const GOOD = "fixture-good-value";
const BAD = "fixture-bad-value";

const app = createApp({ source: new LocalSource({ projectsDir: FIX, host: "fx", version: "1.2.3" }), token: GOOD });
// route requests straight into the Hono app: no port, no network
const fetchApp: FetchLike = async (input, init) => app.fetch(new Request(input, init));
const bearer = (v: string) => ({ headers: { authorization: `Bearer ${v}` } });

describe("agent app", () => {
  test("rejects a missing or wrong token on every route", async () => {
    for (const path of ["/meta", "/sessions", `/sessions/${A}`, `/sessions/${A}/records`]) {
      expect((await app.fetch(new Request(`http://x${path}`))).status).toBe(401);
      expect((await app.fetch(new Request(`http://x${path}`, bearer(BAD)))).status).toBe(401);
    }
  });

  test("HttpSource round-trips meta, list, get, records through the app", async () => {
    const src = new HttpSource({ host: "remote-a", url: "http://x", token: GOOD, fetch: fetchApp });
    const meta = await src.meta();
    expect(meta.version).toBe("1.2.3");
    const list = await src.listSessions({ limit: 5 });
    expect(list).toHaveLength(2);
    // the caller's name for the host wins over whatever the remote calls itself
    expect(list.every((m) => m.host === "remote-a")).toBe(true);
    const one = await src.getSession(A);
    expect(one?.title).toBe("List files in proj-a");
    expect(await src.getSession("nope")).toBeNull();
    const types: string[] = [];
    for await (const r of src.readSession(A)) types.push(r.type);
    expect(types).toHaveLength(11);
    let n = 0;
    for await (const _ of src.readSession("nope")) n++;
    expect(n).toBe(0);
  });

  test("bad limit is a 400; auth failure surfaces as RemoteError naming the host", async () => {
    const res = await app.fetch(new Request("http://x/sessions?limit=-1", bearer(GOOD)));
    expect(res.status).toBe(400);
    const wrong = new HttpSource({ host: "remote-a", url: "http://x", token: BAD, fetch: fetchApp });
    await expect(wrong.meta()).rejects.toBeInstanceOf(RemoteError);
    await expect(wrong.meta()).rejects.toThrow(/remote-a: HTTP 401/);
  });
});
