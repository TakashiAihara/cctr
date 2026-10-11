import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type FetchLike, HttpSource, LocalSource, type SessionHits } from "@cctr/core";
import { Code } from "@connectrpc/connect";
import { createApp } from "../src";

const FIX = join(import.meta.dir, "..", "..", "core", "test", "fixtures", "2.1.267");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const GOOD = "fixture-good-value";

const app = createApp({ source: new LocalSource({ projectsDir: FIX, host: "fx" }), token: GOOD });
const fetchApp: FetchLike = async (input, init) => app.fetch(new Request(input, init));

describe("Search over HTTP", () => {
  test("HttpSource.search round-trips sessions, hits and totals through the app", async () => {
    const src = new HttpSource({ host: "remote-a", url: "http://x", token: GOOD, fetch: fetchApp });
    const out: SessionHits[] = [];
    for await (const s of src.search({ query: "FILES", hitsPerSession: 1, context: 3 })) out.push(s);
    expect(out).toHaveLength(1);
    expect(out[0]!.session.id).toBe(A);
    expect(out[0]!.session.host).toBe("remote-a");
    expect(out[0]!.session.title).toBe("List files in proj-a");
    expect(out[0]!.total).toBe(2);
    expect(out[0]!.hits).toEqual([
      { uuid: out[0]!.hits[0]!.uuid, ts: "2026-09-01T00:00:00.000Z", role: "user", kind: "text", excerpt: "…he files" },
    ]);
  });

  test("an invalid regex reaches the caller as an error", async () => {
    const src = new HttpSource({ host: "remote-a", url: "http://x", token: GOOD, fetch: fetchApp });
    const run = async () => {
      for await (const _ of src.search({ query: "(", regex: true })) {
        // nothing
      }
    };
    await expect(run()).rejects.toThrow(/remote-a/);
    // the caller's mistake, not a server failure
    await expect(run()).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  test("Search needs the token like every other procedure", async () => {
    const res = await app.fetch(
      new Request("http://x/cctr.v1.TranscriptService/Search", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);
  });
});
