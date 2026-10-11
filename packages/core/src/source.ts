import { hostname } from "node:os";
import { type FileEntry, listSessionFiles, projectsDir, resolveSessionFile } from "./discover";
import { readRecords } from "./records";
import { type Matcher, blockHits, compileMatcher, linePrefilter } from "./search";
import { parseSession } from "./session";
import type { Record, SearchHit, SearchQuery, SessionFilter, SessionHits, SessionMeta } from "./types";

/** What one machine's cctr answers about itself. Consumers key remotes on `host`. */
export type SourceMeta = {
  name: "cctr";
  version: string;
  /** Bumped when the shape of SessionMeta / records changes incompatibly. */
  schemaVersion: number;
  host: string;
  projectsDir: string;
};

export const SCHEMA_VERSION = 2;

/** The first schema whose getSession resolves a sid; an older host can only be asked for its listing. */
export const SID_SCHEMA = 2;

const MTIME_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * One place transcripts come from: this machine, or a cctr reached over HTTP
 * or SSH. Every surface (CLI, MCP, Web, TUI) talks to a Source, so a remote
 * host is nothing more than another implementation of this interface.
 */
export type Source = {
  readonly host: string;
  meta(): Promise<SourceMeta>;
  listSessions(filter?: SessionFilter): Promise<SessionMeta[]>;
  getSession(idOrLatest: string): Promise<SessionMeta | null>;
  readSession(idOrLatest: string): AsyncGenerator<Record>;
  search(q: SearchQuery): AsyncGenerator<SessionHits>;
};

export type LocalSourceOptions = { host?: string; projectsDir?: string; version?: string };

export class LocalSource implements Source {
  readonly host: string;
  private readonly dir: string;
  private readonly version: string;

  constructor(opts: LocalSourceOptions = {}) {
    this.host = opts.host ?? "local";
    this.dir = opts.projectsDir ?? projectsDir();
    this.version = opts.version ?? "0.0.0";
  }

  async meta(): Promise<SourceMeta> {
    return {
      name: "cctr",
      version: this.version,
      schemaVersion: SCHEMA_VERSION,
      host: this.host === "local" ? machineId() : this.host,
      projectsDir: this.dir,
    };
  }

  async listSessions(filter: SessionFilter = {}): Promise<SessionMeta[]> {
    const sinceT = filter.since ? Date.parse(filter.since) : NaN;
    const out: SessionMeta[] = [];
    for (const f of listSessionFiles(this.dir)) {
      // Files are newest-first by mtime, and a file whose mtime is before `since` was last
      // written before `since`, so it holds no record stamped after it. Stopping here spares
      // parsing the older files. A day of slack covers a clock that ran ahead of the filesystem;
      // beyond that the records themselves decide (the lastTs check below).
      if (!Number.isNaN(sinceT) && f.mtimeMs < sinceT - MTIME_SLACK_MS) break;
      const m = await parseSession(f, this.host);
      if (filter.cwd && m.cwd !== filter.cwd) continue;
      if (!Number.isNaN(sinceT) && !(m.lastTs && Date.parse(m.lastTs) >= sinceT)) continue;
      out.push(m);
      if (filter.limit && out.length >= filter.limit) break;
    }
    return out;
  }

  async getSession(idOrLatest: string): Promise<SessionMeta | null> {
    const f = resolveSessionFile(idOrLatest, listSessionFiles(this.dir));
    return f ? parseSession(f, this.host) : null;
  }

  async *readSession(idOrLatest: string): AsyncGenerator<Record> {
    const f = resolveSessionFile(idOrLatest, listSessionFiles(this.dir));
    if (!f) return;
    yield* readRecords(f.file);
  }

  async *search(q: SearchQuery): AsyncGenerator<SessionHits> {
    // compiled before any file is opened: an invalid regex is a caller error,
    // not a session that happened to match nothing
    const match = compileMatcher(q);
    const keep = linePrefilter(q);
    const sinceT = q.since ? Date.parse(q.since) : NaN;
    const files = q.session
      ? single(resolveSessionFile(q.session, listSessionFiles(this.dir)))
      : listSessionFiles(this.dir);
    let found = 0;
    for (const f of files) {
      if (!Number.isNaN(sinceT) && f.mtimeMs < sinceT - MTIME_SLACK_MS) break;
      // most files do not hold the query at all; one read of the whole file rules them out
      if (keep && !keep(await Bun.file(f.file).text())) continue;
      const hits = await scanFile(f.file, q, match, keep);
      if (hits.length === 0) continue;
      const m = await parseSession(f, this.host);
      if (q.cwd && m.cwd !== q.cwd) continue;
      if (!Number.isNaN(sinceT) && !(m.lastTs && Date.parse(m.lastTs) >= sinceT)) continue;
      yield {
        session: m,
        total: hits.length,
        hits: q.hitsPerSession ? hits.slice(0, q.hitsPerSession) : hits,
      };
      if (q.limit && ++found >= q.limit) return;
    }
  }
}

function single(f: FileEntry | null): FileEntry[] {
  return f ? [f] : [];
}

/** One streaming pass over a file, collecting the hits it holds. */
async function scanFile(
  file: string,
  q: SearchQuery,
  match: Matcher,
  keep: ((line: string) => boolean) | undefined,
): Promise<SearchHit[]> {
  const out: SearchHit[] = [];
  for await (const rec of readRecords(file, keep)) out.push(...blockHits(rec, q, match));
  return out;
}

/** What this machine is called across the fleet: hostname unless CCX_MACHINE says otherwise (ccx's setting, not a cctr one). */
export function machineId(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCX_MACHINE?.trim() || hostname();
}
