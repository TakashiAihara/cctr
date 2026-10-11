import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { isSid, sidOf } from "./sid";

export function projectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCTR_PROJECTS_DIR || env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
}

export type FileEntry = { file: string; mtimeMs: number; sizeBytes: number };

/**
 * Every session JSONL directly under a project directory, newest first.
 * Subagent transcripts live one level deeper (`<session>/subagents/`) and are
 * not sessions in their own right, so they are not listed here.
 */
export function listSessionFiles(dir = projectsDir()): FileEntry[] {
  if (!existsSync(dir)) return [];
  const out: FileEntry[] = [];
  for (const proj of safeReaddir(dir)) {
    const projPath = join(dir, proj);
    if (!safeStat(projPath)?.isDirectory()) continue;
    for (const f of safeReaddir(projPath)) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = join(projPath, f);
      const st = safeStat(fp);
      if (!st?.isFile()) continue;
      out.push({ file: fp, mtimeMs: st.mtimeMs, sizeBytes: st.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Resolve a session id, a unique prefix of one, its sid, or the literal
 * `latest`, to a file. An exact id always wins; a name that matches several
 * sessions is an error rather than a guess, since a guess would hand back the
 * wrong transcript.
 */
export function resolveSessionFile(idOrLatest: string, files = listSessionFiles()): FileEntry | null {
  if (idOrLatest === "latest") return files[0] ?? null;
  const exact = files.find((f) => basename(f.file, ".jsonl") === idOrLatest);
  if (exact) return exact;
  // an all-digit sid is also a valid id prefix, so a sid-shaped name is looked up both ways
  const matches = files.filter((f) => {
    const id = basename(f.file, ".jsonl");
    return id.startsWith(idOrLatest) || (isSid(idOrLatest) && sidOf(id) === idOrLatest);
  });
  return matches.length ? only(idOrLatest, matches) : null;
}

function only(idOrLatest: string, matches: FileEntry[]): FileEntry {
  if (matches.length > 1) {
    throw new AmbiguousIdError(
      idOrLatest,
      matches.map((f) => basename(f.file, ".jsonl")),
    );
  }
  return matches[0]!;
}

export class AmbiguousIdError extends Error {
  constructor(
    readonly prefix: string,
    readonly ids: string[],
  ) {
    const shown = ids.slice(0, 3).join(", ") + (ids.length > 3 ? ", ..." : "");
    super(`ambiguous session id ${prefix}: matches ${ids.length} sessions (${shown})`);
  }
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function safeStat(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
