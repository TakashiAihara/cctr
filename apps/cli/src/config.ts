import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RemoteHttp = { kind: "http"; url: string; token: string };
export type RemoteSsh = { kind: "ssh"; target: string; command?: string };
export type Remote = RemoteHttp | RemoteSsh;
export type Remotes = { [name: string]: Remote };

export function configDir(env = process.env): string {
  return env.CCTR_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cctr");
}

export function stateDir(env = process.env): string {
  return env.CCTR_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cctr");
}

export function remotesPath(): string {
  return join(configDir(), "remotes.json");
}

/** Missing file is no remotes; a broken file is an error, not silently no remotes. */
export function loadRemotes(path = remotesPath()): Remotes {
  // a null-prototype map, so a remote named `toString` or `constructor` cannot resolve to Object.prototype
  const out: Remotes = Object.create(null);
  if (!existsSync(path)) return out;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { remotes?: Remotes };
  for (const [k, v] of Object.entries(raw.remotes ?? {})) out[k] = v;
  return out;
}

export function saveRemotes(remotes: Remotes, path = remotesPath()): void {
  writePrivate(path, JSON.stringify({ remotes }, null, 2) + "\n");
}

/** The agent's own record: what is running, where, and the token it answers to. */
export type AgentState = { pid: number; bind: string; port: number; token: string; startedAt: string; version: string };

export function agentStatePath(): string {
  return join(stateDir(), "agent.json");
}

export function loadAgentState(path = agentStatePath()): AgentState | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as AgentState;
}

export function saveAgentState(st: AgentState, path = agentStatePath()): void {
  writePrivate(path, JSON.stringify(st, null, 2) + "\n");
}

const TOKEN_MIN_LENGTH = 16;

/**
 * One token per host, made on first use; the agent presents it, remotes are handed it.
 * A token file that is empty or truncated (a crash mid-write) must not become a
 * token, because an empty token would make `Bearer ` match every request.
 */
export function hostToken(): string {
  const p = join(stateDir(), "token");
  if (existsSync(p)) {
    const existing = readFileSync(p, "utf8").trim();
    if (existing.length >= TOKEN_MIN_LENGTH) return existing;
    // empty or truncated: refusing beats regenerating, which would silently invalidate every remote holding the old one
    throw new Error(`${p} holds something too short to be a token; delete it to get a new one`);
  }
  const t = randomToken();
  try {
    // exclusive create: two first-time callers cannot end up holding different tokens
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, t + "\n", { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return hostToken();
  }
  return t;
}

export function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString("base64url");
}

/** Write via a sibling temp file and rename, so a crash leaves the old file or none, never a torn one. */
function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
