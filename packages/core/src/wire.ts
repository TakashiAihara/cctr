import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { type Session, SessionSchema, UsageSchema } from "@cctr/proto/cctr/v1/transcripts_pb";
import type { SessionMeta } from "./types";

/**
 * SessionMeta <-> the wire Session. The wire form has no host: the caller names
 * the host it reached, so `toMeta` takes it as an argument. Empty strings on the
 * wire are nulls here, because proto3 has no null for scalars.
 */
export function toWire(m: SessionMeta): Session {
  return create(SessionSchema, {
    id: m.id,
    file: m.file,
    cwd: m.cwd ?? "",
    gitBranch: m.gitBranch ?? "",
    version: m.version ?? "",
    entrypoint: m.entrypoint ?? "",
    title: m.title ?? "",
    lastPrompt: m.lastPrompt ?? "",
    firstTs: m.firstTs ? timestampFromDate(new Date(m.firstTs)) : undefined,
    lastTs: m.lastTs ? timestampFromDate(new Date(m.lastTs)) : undefined,
    durationMs: BigInt(m.durationMs),
    records: BigInt(m.records),
    userTurns: BigInt(m.userTurns),
    assistantMsgs: BigInt(m.assistantMsgs),
    models: m.models,
    usage: create(UsageSchema, {
      input: BigInt(m.usage.input),
      output: BigInt(m.usage.output),
      cacheRead: BigInt(m.usage.cacheRead),
      cacheCreate: BigInt(m.usage.cacheCreate),
    }),
    tools: Object.fromEntries(Object.entries(m.tools).map(([k, v]) => [k, BigInt(v)])),
    sizeBytes: BigInt(m.sizeBytes),
    mtime: timestampFromDate(new Date(m.mtimeMs)),
  });
}

export function toMeta(s: Session, host: string): SessionMeta {
  return {
    id: s.id,
    file: s.file,
    host,
    cwd: s.cwd || null,
    gitBranch: s.gitBranch || null,
    version: s.version || null,
    entrypoint: s.entrypoint || null,
    title: s.title || null,
    lastPrompt: s.lastPrompt || null,
    firstTs: s.firstTs ? timestampDate(s.firstTs).toISOString() : null,
    lastTs: s.lastTs ? timestampDate(s.lastTs).toISOString() : null,
    durationMs: Number(s.durationMs),
    records: Number(s.records),
    userTurns: Number(s.userTurns),
    assistantMsgs: Number(s.assistantMsgs),
    models: s.models,
    usage: {
      input: Number(s.usage?.input ?? 0n),
      output: Number(s.usage?.output ?? 0n),
      cacheRead: Number(s.usage?.cacheRead ?? 0n),
      cacheCreate: Number(s.usage?.cacheCreate ?? 0n),
    },
    tools: Object.fromEntries(Object.entries(s.tools).map(([k, v]) => [k, Number(v)])),
    sizeBytes: Number(s.sizeBytes),
    mtimeMs: s.mtime ? timestampDate(s.mtime).getTime() : 0,
  };
}
