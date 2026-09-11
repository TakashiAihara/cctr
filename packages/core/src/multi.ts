import type { Source } from "./source";
import type { Record, SessionFilter, SessionMeta } from "./types";

export type HostError = { host: string; error: string };

/**
 * Several Sources asked together. One host being down is reported, not fatal:
 * the sessions of the hosts that answered still come back, with `errors`
 * saying who did not.
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

  /** The first host that has the session wins; `host:` prefix on the id pins one. */
  async getSession(id: string): Promise<SessionMeta | null> {
    for (const s of this.pick(id)) {
      const m = await s.getSession(stripHost(id));
      if (m) return m;
    }
    return null;
  }

  async *readSession(id: string): AsyncGenerator<Record> {
    for (const s of this.pick(id)) {
      if (await s.getSession(stripHost(id))) {
        yield* s.readSession(stripHost(id));
        return;
      }
    }
  }

  private pick(id: string): Source[] {
    const i = id.indexOf(":");
    if (i < 0) return this.sources;
    const host = id.slice(0, i);
    return this.sources.filter((s) => s.host === host);
  }
}

function stripHost(id: string): string {
  const i = id.indexOf(":");
  return i < 0 ? id : id.slice(i + 1);
}

/** Remote errors already name their host; the HostError carries it separately, so drop the prefix. */
function errMsg(e: unknown, host: string): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.startsWith(`${host}: `) ? m.slice(host.length + 2) : m;
}
