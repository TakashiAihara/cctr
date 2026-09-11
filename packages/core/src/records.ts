import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Record } from "./types";

/**
 * Stream the records of one JSONL file, one per line, without holding the file
 * in memory. Lines that are not valid JSON are skipped: the last line of a
 * session that is still being written is usually one of those.
 */
export async function* readRecords(file: string): AsyncGenerator<Record> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const rec = parseLine(line);
    if (rec) yield rec;
  }
}

export function parseLine(line: string): Record | null {
  if (!line.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as globalThis.Record<string, unknown>;
  if (typeof r.type !== "string") return null;
  return {
    type: r.type,
    uuid: str(r.uuid),
    parentUuid: r.parentUuid === null ? null : str(r.parentUuid),
    sessionId: str(r.sessionId),
    timestamp: str(r.timestamp),
    cwd: str(r.cwd),
    gitBranch: str(r.gitBranch),
    version: str(r.version),
    entrypoint: str(r.entrypoint),
    isSidechain: bool(r.isSidechain),
    agentId: str(r.agentId),
    isMeta: bool(r.isMeta),
    message: msg(r.message),
    raw,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function msg(v: unknown): Record["message"] {
  if (!v || typeof v !== "object") return undefined;
  const m = v as globalThis.Record<string, unknown>;
  const u = m.usage && typeof m.usage === "object" ? (m.usage as globalThis.Record<string, unknown>) : undefined;
  return {
    role: str(m.role),
    model: str(m.model),
    content: m.content,
    usage: u
      ? {
          input_tokens: num(u.input_tokens),
          output_tokens: num(u.output_tokens),
          cache_read_input_tokens: num(u.cache_read_input_tokens),
          cache_creation_input_tokens: num(u.cache_creation_input_tokens),
        }
      : undefined,
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
