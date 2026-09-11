import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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
 * Resolve a session id (a unique prefix is fine) or the literal `latest` to a
 * file. Files are newest-first, so a prefix picks the most recent match.
 */
export function resolveSessionFile(idOrLatest: string, files = listSessionFiles()): FileEntry | null {
  if (idOrLatest === "latest") return files[0] ?? null;
  return files.find((f) => basename(f.file, ".jsonl").startsWith(idOrLatest)) ?? null;
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
