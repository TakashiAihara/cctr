/** Token usage aggregated over a session (or any set of assistant messages). */
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
};

/** One JSONL line, parsed. Only the fields cctr reads are typed; the rest stays on `raw`. */
export type Record = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  isSidechain?: boolean;
  agentId?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  raw: unknown;
};

export type SessionMeta = {
  id: string;
  /** `base32(sha1(id))[:6]`: the same session under a name that fits on a screen. */
  sid: string;
  file: string;
  /** Host the session file lives on. `local` for the machine cctr runs on. */
  host: string;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  entrypoint: string | null;
  title: string | null;
  lastPrompt: string | null;
  firstTs: string | null;
  lastTs: string | null;
  durationMs: number;
  records: number;
  userTurns: number;
  assistantMsgs: number;
  models: string[];
  usage: Usage;
  tools: globalThis.Record<string, number>;
  sizeBytes: number;
  mtimeMs: number;
};

export type SessionFilter = {
  cwd?: string;
  since?: string;
  limit?: number;
};

export type SearchQuery = {
  query: string;
  /** The query is a JavaScript RegExp source rather than a substring. */
  regex?: boolean;
  /** Default: case-insensitive (substring compares lowercased; a regex gets flag "i"). */
  caseSensitive?: boolean;
  /** Whose words to look at; undefined is both sides. */
  role?: "user" | "assistant";
  /** Also search assistant `thinking` blocks. */
  thinking?: boolean;
  /** Also search assistant `tool_use` blocks. */
  tools?: boolean;
  /** Chars kept either side of the match in an excerpt. */
  context?: number;
  /** Hits kept per session; `total` still counts every matching block. */
  hitsPerSession?: number;
  /** Sessions returned; undefined is all of them. */
  limit?: number;
  /** One session: an id, a unique prefix, `latest`, or `host:id` at MultiSource level. */
  session?: string;
  /** Exact cwd, like SessionFilter. */
  cwd?: string;
  /** ISO time, like SessionFilter.since. */
  since?: string;
};

/** One matching block of one record, with the text around it. */
export type SearchHit = {
  uuid: string | null;
  ts: string | null;
  role: "user" | "assistant";
  kind: "text" | "thinking" | "tool_use";
  excerpt: string;
};

export type SessionHits = {
  session: SessionMeta;
  /** Matching blocks in the session, whether or not `hits` kept them all. */
  total: number;
  hits: SearchHit[];
};

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}
