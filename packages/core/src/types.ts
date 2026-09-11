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

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}
