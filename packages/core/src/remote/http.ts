import { parseLine } from "../records";
import type { Source, SourceMeta } from "../source";
import type { Record, SessionFilter, SessionMeta } from "../types";

/** Narrower than `typeof fetch` so tests can hand in a Hono app's fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpSourceOptions = { host: string; url: string; token: string; fetch?: FetchLike };

/** A cctr agent on another machine, reached over HTTP. */
export class HttpSource implements Source {
  readonly host: string;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchFn: FetchLike;

  constructor(opts: HttpSourceOptions) {
    this.host = opts.host;
    this.base = opts.url.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async meta(): Promise<SourceMeta> {
    return (await this.json("/meta")) as SourceMeta;
  }

  async listSessions(filter: SessionFilter = {}): Promise<SessionMeta[]> {
    const q = new URLSearchParams();
    if (filter.cwd) q.set("cwd", filter.cwd);
    if (filter.since) q.set("since", filter.since);
    if (filter.limit) q.set("limit", String(filter.limit));
    const qs = q.toString();
    const metas = (await this.json(`/sessions${qs ? `?${qs}` : ""}`)) as SessionMeta[];
    return metas.map((m) => ({ ...m, host: this.host }));
  }

  async getSession(idOrLatest: string): Promise<SessionMeta | null> {
    const res = await this.get(`/sessions/${encodeURIComponent(idOrLatest)}`);
    if (res.status === 404) return null;
    await assertOk(res, this.host);
    return { ...((await res.json()) as SessionMeta), host: this.host };
  }

  async *readSession(idOrLatest: string): AsyncGenerator<Record> {
    const res = await this.get(`/sessions/${encodeURIComponent(idOrLatest)}/records`);
    if (res.status === 404) return;
    await assertOk(res, this.host);
    for await (const line of lines(res.body!)) {
      const r = parseLine(line);
      if (r) yield r;
    }
  }

  private get(path: string): Promise<Response> {
    return this.fetchFn(`${this.base}${path}`, { headers: { authorization: `Bearer ${this.token}` } });
  }

  private async json(path: string): Promise<unknown> {
    const res = await this.get(path);
    await assertOk(res, this.host);
    return res.json();
  }
}

export class RemoteError extends Error {
  constructor(
    readonly host: string,
    readonly status: number,
    message: string,
  ) {
    super(`${host}: ${message}`);
  }
}

async function assertOk(res: Response, host: string): Promise<void> {
  if (res.ok) return;
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) detail = body.error;
  } catch {
    // not JSON; the status text is all there is
  }
  throw new RemoteError(host, res.status, `HTTP ${res.status} ${detail}`);
}

/**
 * Split a byte stream on newlines. Every record the agent sends ends in a newline,
 * so an unterminated tail means the transfer was cut; it is dropped, like the
 * half-written last line of a session file, rather than passed off as a record.
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
