import { basename } from "node:path";
import type { FileEntry } from "./discover";
import { readRecords } from "./records";
import { type Record, type SessionMeta, emptyUsage } from "./types";

/** Aggregate one session file into its SessionMeta in a single streaming pass. */
export async function parseSession(entry: FileEntry, host = "local"): Promise<SessionMeta> {
  const meta = emptyMeta(entry, host);
  const st: FoldState = { models: new Set(), usageById: new Map(), untitledUsage: [] };
  for await (const rec of readRecords(entry.file)) {
    fold(meta, rec, st);
  }
  if (meta.firstTs && meta.lastTs) meta.durationMs = Date.parse(meta.lastTs) - Date.parse(meta.firstTs);
  meta.models = [...st.models];
  meta.assistantMsgs = st.usageById.size + st.untitledUsage.length;
  for (const u of [...st.usageById.values(), ...st.untitledUsage]) {
    meta.usage.input += u.input_tokens ?? 0;
    meta.usage.output += u.output_tokens ?? 0;
    meta.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    meta.usage.cacheCreate += u.cache_creation_input_tokens ?? 0;
  }
  return meta;
}

type UsageRaw = NonNullable<NonNullable<Record["message"]>["usage"]>;

/**
 * One API response is written as several `assistant` lines (one per content
 * block) that share `message.id`, each carrying the usage as known at that
 * point. Summing every line over-counts input by about 2x on real data, so
 * usage is kept per message id and the last line for an id wins.
 */
type FoldState = { models: Set<string>; usageById: Map<string, UsageRaw>; untitledUsage: UsageRaw[] };

function emptyMeta(entry: FileEntry, host: string): SessionMeta {
  return {
    id: basename(entry.file, ".jsonl"),
    file: entry.file,
    host,
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    title: null,
    lastPrompt: null,
    firstTs: null,
    lastTs: null,
    durationMs: 0,
    records: 0,
    userTurns: 0,
    assistantMsgs: 0,
    models: [],
    usage: emptyUsage(),
    tools: {},
    sizeBytes: entry.sizeBytes,
    mtimeMs: entry.mtimeMs,
  };
}

function fold(meta: SessionMeta, rec: Record, st: FoldState): void {
  meta.records++;
  // the first value wins: cwd / branch / version are per-session facts, and a
  // later record differing from them is a resume from elsewhere, not a change
  if (rec.cwd && !meta.cwd) meta.cwd = rec.cwd;
  if (rec.gitBranch && !meta.gitBranch) meta.gitBranch = rec.gitBranch;
  if (rec.version && !meta.version) meta.version = rec.version;
  if (rec.entrypoint && !meta.entrypoint) meta.entrypoint = rec.entrypoint;
  if (rec.timestamp) {
    if (!meta.firstTs || rec.timestamp < meta.firstTs) meta.firstTs = rec.timestamp;
    if (!meta.lastTs || rec.timestamp > meta.lastTs) meta.lastTs = rec.timestamp;
  }
  const raw = rec.raw as globalThis.Record<string, unknown>;
  if (rec.type === "ai-title" && typeof raw.aiTitle === "string") meta.title = raw.aiTitle;
  if (rec.type === "last-prompt" && typeof raw.lastPrompt === "string") meta.lastPrompt = raw.lastPrompt;

  if (rec.type === "user" && rec.message && !rec.isMeta && !isToolResultOnly(rec.message.content)) {
    meta.userTurns++;
  }
  if (rec.type === "assistant" && rec.message) {
    // <synthetic> is the pseudo-model on injected turns, not a model that ran
    if (rec.message.model && rec.message.model !== "<synthetic>") st.models.add(rec.message.model);
    const u = rec.message.usage ?? {};
    const id = (rec.raw as { message?: { id?: unknown } }).message?.id;
    if (typeof id === "string") st.usageById.set(id, u);
    else st.untitledUsage.push(u);
    for (const b of blocks(rec.message.content)) {
      if (b.type === "tool_use") {
        const n = typeof b.name === "string" ? b.name : "?";
        meta.tools[n] = (meta.tools[n] ?? 0) + 1;
      }
    }
  }
}

export function blocks(content: unknown): globalThis.Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is globalThis.Record<string, unknown> => !!b && typeof b === "object");
}

function isToolResultOnly(content: unknown): boolean {
  const bs = blocks(content);
  return bs.length > 0 && bs.every((b) => b.type === "tool_result");
}
