import { hostname } from "node:os";
import { listSessionFiles, projectsDir, resolveSessionFile } from "./discover";
import { readRecords } from "./records";
import { parseSession } from "./session";
import type { Record, SessionFilter, SessionMeta } from "./types";

/** What one machine's cctr answers about itself. Consumers key remotes on `host`. */
export type SourceMeta = {
  name: "cctr";
  version: string;
  /** Bumped when the shape of SessionMeta / records changes incompatibly. */
  schemaVersion: number;
  host: string;
  projectsDir: string;
};

export const SCHEMA_VERSION = 1;

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
      host: this.host === "local" ? hostname() : this.host,
      projectsDir: this.dir,
    };
  }

  async listSessions(filter: SessionFilter = {}): Promise<SessionMeta[]> {
    const sinceT = filter.since ? Date.parse(filter.since) : NaN;
    const out: SessionMeta[] = [];
    for (const f of listSessionFiles(this.dir)) {
      // mtime is newest-first, so once a file is older than `since` the rest are too
      if (!Number.isNaN(sinceT) && f.mtimeMs < sinceT) break;
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
}
