import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type Client, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  GetMetaRequestSchema,
  GetSessionRequestSchema,
  ListSessionsRequestSchema,
  ReadRecordsRequestSchema,
  SearchRequestSchema,
  TranscriptService,
} from "@cctr/proto/cctr/v1/transcripts_pb";
import { parseLine } from "../records";
import type { Source, SourceMeta } from "../source";
import type { Record, SearchHit, SearchQuery, SessionFilter, SessionHits, SessionMeta } from "../types";
import { num, toMeta } from "../wire";

/** Narrower than `typeof fetch` so tests can hand in a Hono app's fetch. */
export type FetchLike = (input: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

export type HttpSourceOptions = { host: string; url: string; token: string; fetch?: FetchLike };

/** A cctr agent on another machine, reached over HTTP: a Connect client of TranscriptService. */
export class HttpSource implements Source {
  readonly host: string;
  private readonly client: Client<typeof TranscriptService>;

  constructor(opts: HttpSourceOptions) {
    this.host = opts.host;
    const transport = createConnectTransport({
      baseUrl: opts.url.replace(/\/+$/, ""),
      useBinaryFormat: true,
      fetch: (opts.fetch ?? ((input, init) => fetch(input, init))) as typeof fetch,
      interceptors: [
        (next) => (req) => {
          req.header.set("authorization", `Bearer ${opts.token}`);
          return next(req);
        },
      ],
    });
    this.client = createClient(TranscriptService, transport);
  }

  async meta(): Promise<SourceMeta> {
    const m = await this.wrap(() => this.client.getMeta(create(GetMetaRequestSchema)));
    return {
      name: "cctr",
      version: m.version,
      schemaVersion: m.schemaVersion,
      host: m.machine,
      projectsDir: m.projectsDir,
    };
  }

  async listSessions(filter: SessionFilter = {}): Promise<SessionMeta[]> {
    const res = await this.wrap(() =>
      this.client.listSessions(
        create(ListSessionsRequestSchema, {
          cwd: filter.cwd ?? "",
          since: filter.since ? timestampFromDate(new Date(filter.since)) : undefined,
          limit: filter.limit ?? 0,
        }),
      ),
    );
    return res.sessions.map((s) => toMeta(s, this.host));
  }

  async getSession(idOrLatest: string): Promise<SessionMeta | null> {
    try {
      const res = await this.client.getSession(create(GetSessionRequestSchema, { id: idOrLatest }));
      return res.session ? toMeta(res.session, this.host) : null;
    } catch (e) {
      if (e instanceof ConnectError && e.code === Code.NotFound) return null;
      throw this.remoteError(e);
    }
  }

  async *readSession(idOrLatest: string): AsyncGenerator<Record> {
    try {
      for await (const chunk of this.client.readRecords(create(ReadRecordsRequestSchema, { id: idOrLatest }))) {
        const r = parseLine(chunk.line);
        if (r) yield r;
      }
    } catch (e) {
      if (e instanceof ConnectError && e.code === Code.NotFound) return;
      throw this.remoteError(e);
    }
  }

  async *search(q: SearchQuery): AsyncGenerator<SessionHits> {
    try {
      for await (const res of this.client.search(
        create(SearchRequestSchema, {
          query: q.query,
          regex: q.regex,
          caseSensitive: q.caseSensitive,
          role: q.role ?? "",
          thinking: q.thinking,
          tools: q.tools,
          context: q.context,
          hitsPerSession: q.hitsPerSession ?? 0,
          limit: q.limit ?? 0,
          session: q.session ?? "",
          cwd: q.cwd ?? "",
          since: q.since ? timestampFromDate(new Date(q.since)) : undefined,
        }),
      )) {
        if (!res.session) continue;
        yield {
          session: toMeta(res.session, this.host),
          total: num(res.total, "total"),
          hits: res.hits.map((h) => ({
            // proto3 has no null for scalars, so an absent uuid or timestamp is an empty string
            uuid: h.uuid || null,
            ts: h.ts || null,
            role: h.role as SearchHit["role"],
            kind: h.kind as SearchHit["kind"],
            excerpt: h.excerpt,
          })),
        };
      }
    } catch (e) {
      throw this.remoteError(e);
    }
  }

  private async wrap<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      throw this.remoteError(e);
    }
  }

  private remoteError(e: unknown): RemoteError {
    if (e instanceof ConnectError) return new RemoteError(this.host, e.code, `${Code[e.code]}: ${e.rawMessage}`);
    return new RemoteError(this.host, Code.Unknown, e instanceof Error ? e.message : String(e));
  }
}

export class RemoteError extends Error {
  constructor(
    readonly host: string,
    readonly code: Code,
    message: string,
  ) {
    super(`${host}: ${message}`);
  }
}

/**
 * Split a byte stream on newlines. Every record the sender emits ends in a
 * newline, so an unterminated tail means the transfer was cut; it is dropped,
 * like the half-written last line of a session file, rather than passed off as
 * a record. Used by the SSH path, which streams the CLI's NDJSON.
 */
export async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  dec.decode();
}
