import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { parseLine } from "../records";
import type { Source, SourceMeta } from "../source";
import type { Record, SessionFilter, SessionMeta } from "../types";
import { lines } from "./http";

export type SshSourceOptions = {
  host: string;
  /** What goes after `ssh`: `user@machine` or an alias from ssh_config. */
  target: string;
  /** The cctr binary on the remote. Non-login shells often lack ~/.local/bin on PATH, so the default is absolute-ish. */
  command?: string;
  sshCommand?: string;
};

/**
 * A cctr on another machine, driven over SSH by running its CLI there. No port
 * to open and no token to share: whoever can `ssh` in can read the transcripts,
 * which is already true of the files themselves.
 */
export class SshSource implements Source {
  readonly host: string;
  private readonly target: string;
  private readonly command: string;
  private readonly ssh: string;

  constructor(opts: SshSourceOptions) {
    if (!isSshTarget(opts.target)) throw new Error(`not an ssh target: ${JSON.stringify(opts.target)}`);
    this.host = opts.host;
    this.target = opts.target;
    this.command = opts.command ?? "cctr";
    this.ssh = opts.sshCommand ?? "ssh";
  }

  async meta(): Promise<SourceMeta> {
    return JSON.parse(await this.run(["meta"])) as SourceMeta;
  }

  async listSessions(filter: SessionFilter = {}): Promise<SessionMeta[]> {
    const args = ["sessions", "list"];
    if (filter.cwd) args.push("--cwd", filter.cwd);
    if (filter.since) args.push("--since", filter.since);
    if (filter.limit) args.push("--limit", String(filter.limit));
    const metas = JSON.parse(await this.run(args)) as SessionMeta[];
    return metas.map((m) => ({ ...m, host: this.host }));
  }

  async getSession(idOrLatest: string): Promise<SessionMeta | null> {
    const out = await this.runOrNull(["sessions", "get", idOrLatest], [3]);
    if (out === null) return null;
    return { ...(JSON.parse(out) as SessionMeta), host: this.host };
  }

  async *readSession(idOrLatest: string): AsyncGenerator<Record> {
    const child = this.spawn(["sessions", "records", idOrLatest]);
    const stderr = collect(child.stderr!).catch(() => "");
    let drained = false;
    try {
      for await (const line of lines(toWeb(child.stdout!))) {
        const r = parseLine(line);
        if (r) yield r;
      }
      drained = true;
      const code = await exited(child);
      if (code !== 0 && code !== 3) throw new SshError(this.host, code, await stderr);
    } finally {
      // a consumer that stops early (reading the first few records) must not leave an ssh behind
      if (!drained) child.kill("SIGTERM");
    }
  }

  private async run(args: string[]): Promise<string> {
    const out = await this.runOrNull(args, []);
    return out as string;
  }

  /** Run one remote command and return its stdout. `allowExit` codes return null instead of throwing. */
  private async runOrNull(args: string[], allowExit: number[]): Promise<string | null> {
    const child = this.spawn(args);
    const [out, err, code] = await Promise.all([collect(child.stdout!), collect(child.stderr!), exited(child)]);
    if (code === 0) return out;
    if (allowExit.includes(code)) return null;
    throw new SshError(this.host, code, err);
  }

  private spawn(args: string[]) {
    // BatchMode: a missing key fails at once instead of hanging on a password prompt.
    // ConnectTimeout: an unreachable host answers in seconds, not the kernel's minutes.
    // ServerAlive: a connection that dies after it was established is noticed in ~15s.
    const remote = [this.command, ...args].map(shellQuote).join(" ");
    const opts = [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=3",
    ];
    // `--` keeps a target that starts with `-` from being read as an ssh option (ProxyCommand and friends)
    return spawn(this.ssh, [...opts, "--", this.target, remote], { stdio: ["ignore", "pipe", "pipe"] });
  }
}

export class SshError extends Error {
  constructor(
    readonly host: string,
    readonly exitCode: number,
    stderr: string,
  ) {
    super(`${host}: ssh exited ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
}

/** Quote for the remote shell. `~` stays bare so `--command ~/.local/bin/cctr` still expands there. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) out += chunk;
  return out;
}

function exited(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    // a signal has no code; 128+n is the shell's own convention for it, so it reads the same way
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 + (signalNumber[signal] ?? 0) : 1)));
  });
}

const signalNumber: Partial<globalThis.Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGPIPE: 13,
  SIGTERM: 15,
};

/** Node's own conversion keeps backpressure; a hand-rolled one would buffer a whole session. */
function toWeb(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream as Readable) as unknown as ReadableStream<Uint8Array>;
}

/** `user@host`, `host`, or an ssh_config alias: never empty, never starting with `-`, no whitespace. */
export function isSshTarget(t: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.@:%[\]-]*$/.test(t);
}
