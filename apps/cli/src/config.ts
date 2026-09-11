import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as { remotes?: Remotes };
  return raw.remotes ?? {};
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

/** One token per host, made on first use; the agent presents it, remotes are handed it. */
export function hostToken(): string {
  const p = join(stateDir(), "token");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const t = randomToken();
  writePrivate(p, t + "\n");
  return t;
}

export function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString("base64url");
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}
