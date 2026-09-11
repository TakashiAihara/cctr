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
  const app = new Hono();

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    if (!timingSafeEqual(auth, `Bearer ${token}`)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/meta", async (c) => c.json(await source.meta()));

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

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}
