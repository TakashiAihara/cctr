import { Hono } from "hono";
import type { Source } from "@cctr/core";

export type AppOptions = {
  source: Source;
  /** Every request must carry `Authorization: Bearer <token>`. */
  token: string;
};

/**
 * The HTTP face of one machine's transcripts. Read-only: the JSONL is never
 * written through here. The same routes serve the CLI on another host, the
 * Web UI, and (later) ccx pulling several machines together.
 */
export function createApp({ source, token }: AppOptions): Hono {
  if (token.length < 16) throw new Error("agent token must be at least 16 characters");
  const expected = digest("Bearer " + token);
  const app = new Hono();

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    if (!timingSafeEqual(digest(auth), expected)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  // pid lets the CLI on this machine check it is talking to the process it started
  app.get("/meta", async (c) => c.json({ ...(await source.meta()), pid: process.pid }));

  app.get("/sessions", async (c) => {
    const q = c.req.query();
    const limit = q.limit ? Number.parseInt(q.limit, 10) : undefined;
    if (q.limit && !(Number.isInteger(limit) && limit! > 0))
      return c.json({ error: "limit must be a positive integer" }, 400);
    return c.json(await source.listSessions({ cwd: q.cwd, since: q.since, limit }));
  });

  app.get("/sessions/:id", async (c) => {
    const m = await source.getSession(c.req.param("id"));
    return m ? c.json(m) : c.json({ error: "not found" }, 404);
  });

  app.get("/sessions/:id/records", async (c) => {
    const id = c.req.param("id");
    if (!(await source.getSession(id))) return c.json({ error: "not found" }, 404);
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        for await (const r of source.readSession(id)) ctrl.enqueue(enc.encode(JSON.stringify(r.raw) + "\n"));
        ctrl.close();
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  });

  return app;
}

/** Both sides are hashed first, so the comparison is fixed-length and leaks neither length nor prefix. */
function digest(s: string): Uint8Array {
  return new Uint8Array(new Bun.CryptoHasher("sha256").update(s).digest());
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ (b[i] ?? 0);
  return diff === 0;
}
