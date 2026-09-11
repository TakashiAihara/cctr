import type { Source } from "./source";
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
    const { source } = await this.locate(id);
    if (source) yield* source.readSession(splitHost(id).id);
  }

  private async locate(id: string): Promise<{ source: Source | null; meta: SessionMeta | null }> {
    const { id: bare } = splitHost(id);
    const sources = this.pick(id);
    const results = await Promise.allSettled(sources.map((s) => s.getSession(bare)));
    const errors: HostError[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled" && r.value) return { source: sources[i]!, meta: r.value };
      if (r.status === "rejected") errors.push({ host: sources[i]!.host, error: errMsg(r.reason, sources[i]!.host) });
    }
    if (errors.length) throw new HostsUnreachableError(errors);
    return { source: null, meta: null };
  }

  private pick(id: string): Source[] {
    const { host } = splitHost(id);
    return host === null ? this.sources : this.sources.filter((s) => s.host === host);
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

/** Remote errors already name their host; the HostError carries it separately, so drop the prefix. */
function errMsg(e: unknown, host: string): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith(`${host}: `) ? m.slice(host.length + 2) : m;
}
