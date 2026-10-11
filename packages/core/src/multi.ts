import { AmbiguousIdError } from "./discover";
import { isSid } from "./sid";
import { SID_SCHEMA, type Source } from "./source";
import type { Record, SessionFilter, SessionMeta } from "./types";

export type HostError = { host: string; error: string };

/**
 * Several Sources asked together. One host being down is reported, not fatal:
 * listSessions returns what the others had plus `errors`; getSession and
 * readSession skip the failed host and raise only when nobody had the session.
 */
export class MultiSource {
  constructor(readonly sources: Source[]) {}

  async listSessions(filter: SessionFilter = {}): Promise<{ sessions: SessionMeta[]; errors: HostError[] }> {
    const results = await Promise.allSettled(this.sources.map((s) => s.listSessions(filter)));
    const sessions: SessionMeta[] = [];
    const errors: HostError[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") sessions.push(...r.value);
      else errors.push({ host: this.sources[i]!.host, error: errMsg(r.reason, this.sources[i]!.host) });
    });
    sessions.sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
    return { sessions: filter.limit ? sessions.slice(0, filter.limit) : sessions, errors };
  }

  /**
   * The first host that has the session wins; a `host:` prefix pins one. Hosts are
   * asked in parallel, and one that fails is skipped like in listSessions. Only when
   * nobody has it and somebody failed is the failure raised, so "not found" is never
   * reported over an unreachable host.
   */
  async getSession(id: string): Promise<SessionMeta | null> {
    const { meta } = await this.locate(id);
    return meta;
  }

  async *readSession(id: string): AsyncGenerator<Record> {
    const { source, meta } = await this.locate(id);
    // the id the host resolved to: a host that cannot resolve a sid itself can still read by id
    if (source && meta) yield* source.readSession(meta.id);
  }

  private async locate(id: string): Promise<{ source: Source | null; meta: SessionMeta | null }> {
    const { id: bare } = splitHost(id);
    const sources = this.pick(id);
    const results = await Promise.allSettled(sources.map((s) => s.getSession(bare)));
    if (isSid(bare)) return locateSid(bare, sources, results);
    const errors: HostError[] = [];
    let best: { source: Source; meta: SessionMeta } | null = null;
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "rejected") {
        errors.push({ host: sources[i]!.host, error: errMsg(r.reason, sources[i]!.host) });
        continue;
      }
      if (!r.value) continue;
      // `latest` means the newest across every host asked, not the first host that answered
      if (bare !== "latest") return { source: sources[i]!, meta: r.value };
      if (!best || (r.value.lastTs ?? "") > (best.meta.lastTs ?? "")) best = { source: sources[i]!, meta: r.value };
    }
    if (best) return best;
    if (errors.length) throw new HostsUnreachableError(errors);
    return { source: null, meta: null };
  }

  private pick(id: string): Source[] {
    const { host } = splitHost(id);
    if (host === null) return this.sources;
    const picked = this.sources.filter((s) => s.host === host);
    // a misspelt host must not read as "no such session"
    if (picked.length === 0)
      throw new UnknownHostError(
        host,
        this.sources.map((s) => s.host),
      );
    return picked;
  }
}

export class UnknownHostError extends Error {
  constructor(
    readonly host: string,
    known: string[],
  ) {
    super(`unknown host: ${host} (known: ${known.join(", ")})`);
  }
}

export class HostsUnreachableError extends Error {
  constructor(readonly errors: HostError[]) {
    super(errors.map((e) => `${e.host}: ${e.error}`).join("; "));
  }
}

/** `host:id` addresses one host. A leading colon is not a host, it is part of a strange id. */
export function splitHost(id: string): { host: string | null; id: string } {
  const i = id.indexOf(":");
  return i > 0 ? { host: id.slice(0, i), id: id.slice(i + 1) } : { host: null, id };
}

/**
 * A sid is a hash, so unlike a prefix it can name sessions on two hosts at once;
 * every host is checked and two hits are refused. A host that answered "not found"
 * and reports a schema older than sids is listed and hashed here, whether or not
 * another host already had a hit, so a collision with it is still seen.
 */
async function locateSid(
  sid: string,
  sources: Source[],
  results: PromiseSettledResult<SessionMeta | null>[],
): Promise<{ source: Source | null; meta: SessionMeta | null }> {
  const errors: HostError[] = [];
  const hits: { source: Source; meta: SessionMeta }[] = [];
  const answered: Source[] = [];
  results.forEach((r, i) => {
    const source = sources[i]!;
    // a host that found the sid twice is a refusal, not an unreachable host
    if (r.status === "rejected" && r.reason instanceof AmbiguousIdError) throw r.reason;
    if (r.status === "rejected") errors.push({ host: source.host, error: errMsg(r.reason, source.host) });
    else if (r.value) hits.push({ source, meta: r.value });
    else answered.push(source);
  });
  const listed = await Promise.allSettled(
    answered.map(async (s) => ((await s.meta()).schemaVersion < SID_SCHEMA ? s.listSessions() : [])),
  );
  listed.forEach((r, i) => {
    const source = answered[i]!;
    if (r.status === "rejected") errors.push({ host: source.host, error: errMsg(r.reason, source.host) });
    else hits.push(...r.value.filter((m) => m.sid === sid).map((meta) => ({ source, meta })));
  });

  if (hits.length > 1)
    throw new AmbiguousIdError(
      sid,
      hits.map((h) => `${h.source.host}:${h.meta.id}`),
    );
  if (hits[0]) return hits[0];
  if (errors.length) throw new HostsUnreachableError(errors);
  return { source: null, meta: null };
}

/** Remote errors already name their host; the HostError carries it separately, so drop the prefix. */
function errMsg(e: unknown, host: string): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith(`${host}: `) ? m.slice(host.length + 2) : m;
}
