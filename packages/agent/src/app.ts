import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl, createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { type Source, toWire } from "@cctr/core";
import {
  GetMetaResponseSchema,
  GetSessionResponseSchema,
  ListSessionsResponseSchema,
  ReadRecordsResponseSchema,
  TranscriptService,
} from "@cctr/proto/cctr/v1/transcripts_pb";
import { Hono } from "hono";

export type AppOptions = {
  source: Source;
  /** Every request must carry `Authorization: Bearer <token>`. */
  token: string;
  /** Reported on /healthz; defaults to the package version the CLI passes in. */
  version?: string;
};

/**
 * The HTTP face of one machine's transcripts: TranscriptService (Connect) on
 * Hono. Read-only, and the same contract whether the caller is the CLI on
 * another machine, the Web UI, or ccx pulling machines together.
 *
 * connect-node wants node:http and does not fit Bun's fetch server; the core
 * createFetchHandler turns each universal handler into Request -> Response,
 * and that goes on a Hono route — the same arrangement as ccx-center.
 */
export function createApp({ source, token, version = "0.0.0" }: AppOptions): Hono {
  if (token.length < 16) throw new Error("agent token must be at least 16 characters");
  const expected = digest("Bearer " + token);

  const router = createConnectRouter();
  router.service(TranscriptService, transcriptImpl(source));

  const app = new Hono();

  // Unauthenticated on purpose and says nothing about the transcripts: the CLI on this
  // machine identifies the process on the port with it, so the token never has to be
  // offered to a listener that has not proved it is ours. Same shape as ccx-center.
  app.get("/healthz", (c) => c.json({ name: "cctr", pid: process.pid, version }));

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    if (!timingSafeEqual(digest(auth), expected)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  for (const uHandler of router.handlers) {
    const handler = createFetchHandler(uHandler);
    app.all(uHandler.requestPath, (c) => handler(c.req.raw));
  }

  return app;
}

export function transcriptImpl(source: Source): ServiceImpl<typeof TranscriptService> {
  return {
    async getMeta() {
      const m = await source.meta();
      return create(GetMetaResponseSchema, {
        name: m.name,
        version: m.version,
        schemaVersion: m.schemaVersion,
        machine: m.host,
        projectsDir: m.projectsDir,
        // lets the CLI on this machine check it is talking to the process it started
        pid: process.pid,
      });
    },

    async listSessions(req) {
      const metas = await source.listSessions({
        cwd: req.cwd || undefined,
        since: req.since ? timestampDate(req.since).toISOString() : undefined,
        limit: req.limit || undefined,
      });
      return create(ListSessionsResponseSchema, { sessions: metas.map(toWire) });
    },

    async getSession(req) {
      const m = await source.getSession(req.id);
      if (!m) throw new ConnectError(`session not found: ${req.id}`, Code.NotFound);
      return create(GetSessionResponseSchema, { session: toWire(m) });
    },

    async *readRecords(req) {
      if (!(await source.getSession(req.id))) throw new ConnectError(`session not found: ${req.id}`, Code.NotFound);
      for await (const r of source.readSession(req.id)) {
        yield create(ReadRecordsResponseSchema, { line: JSON.stringify(r.raw) });
      }
    },
  };
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
