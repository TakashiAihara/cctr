import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { parseLine } from "../records";
import { sidOf } from "../sid";
import type { Source, SourceMeta } from "../source";
import type { Record, SearchQuery, SessionFilter, SessionHits, SessionMeta } from "../types";
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
    // no limit means every session, but the remote CLI has a default of its own
    args.push("--limit", String(filter.limit || Number.MAX_SAFE_INTEGER));
    const metas = JSON.parse(await this.run(args)) as SessionMeta[];
    return metas.map((m) => this.adopt(m));
  }

  async getSession(idOrLatest: string): Promise<SessionMeta | null> {
    const out = await this.runOrNull(["sessions", "get", idOrLatest], [3]);
    if (out === null) return null;
    return this.adopt(JSON.parse(out) as SessionMeta);
  }

  async *readSession(idOrLatest: string): AsyncGenerator<Record> {
    for await (const line of this.stream(["sessions", "records", idOrLatest])) {
      const r = parseLine(line);
      if (r) yield r;
    }
  }

  async *search(q: SearchQuery): AsyncGenerator<SessionHits> {
    // global options before the subcommand, so the remote's own cctr reads them
    const args = ["--host", "local", "--format", "ndjson", "search", q.query];
    if (q.regex) args.push("--regex");
    if (q.caseSensitive) args.push("--case");
    if (q.role) args.push("--role", q.role);
    if (q.thinking) args.push("--thinking");
    if (q.tools) args.push("--tools");
    if (q.context) args.push("--context", String(q.context));
    if (q.hitsPerSession) args.push("--hits-per", String(q.hitsPerSession));
    if (q.limit) args.push("--limit", String(q.limit));
    if (q.session) args.push("--session", q.session);
    if (q.cwd) args.push("--cwd", q.cwd);
    if (q.since) args.push("--since", q.since);
    for await (const line of this.stream(args)) {
      const hits = JSON.parse(line) as SessionHits;
      // the remote answers as `local`; the caller knows the name it reached it by
      yield { ...hits, session: { ...hits.session, host: this.host } };
    }
  }

  /**
   * One remote command whose stdout is NDJSON, line by line. An exit of 3 is the
   * remote's "nothing found", which for a stream means an empty result, not a
   * failure; anything else non-zero carries the child's stderr.
   */
  private async *stream(args: string[]): AsyncGenerator<string> {
    const child = this.spawn(args);
    const stderr = collect(child.stderr!).catch(() => "");
    // listen for exit (and the `error` a missing ssh binary raises) before reading stdout:
    // an `error` with nobody listening would crash the process instead of rejecting here
    const exit = exited(child).catch((e: unknown) => e as Error);
    let drained = false;
    try {
      try {
        yield* lines(toWeb(child.stdout!));
      } catch (streamErr) {
        // the stream aborts when the child could not start; the spawn error says why, the abort does not
        const outcome = await exit;
        if (outcome instanceof Error) throw new SshError(this.host, -1, outcome.message);
        throw streamErr;
      }
      drained = true;
      const outcome = await exit;
      if (outcome instanceof Error) throw new SshError(this.host, -1, outcome.message);
      if (outcome !== 0 && outcome !== 3) throw new SshError(this.host, outcome, await stderr);
    } finally {
      // a consumer that stops early (reading the first few records) must not leave an ssh behind
      if (!drained) child.kill("SIGTERM");
    }
  }

  /** A remote too old to know the sid still names the session, so the sid is recomputed rather than read. */
  private adopt(m: SessionMeta): SessionMeta {
    return { ...m, host: this.host, sid: sidOf(m.id) };
  }

  private async run(args: string[]): Promise<string> {
    const out = await this.runOrNull(args, []);
    return out as string;
  }

  /** Run one remote command and return its stdout. `allowExit` codes return null instead of throwing. */
  private async runOrNull(args: string[], allowExit: number[]): Promise<string | null> {
    const child = this.spawn(args);
    const [out, err, code] = await Promise.all([
      collect(child.stdout!).catch(() => ""),
      collect(child.stderr!).catch(() => ""),
      exited(child).catch((e: unknown) => {
        throw new SshError(this.host, -1, (e as Error).message);
      }),
    ]);
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
    /** -1 when ssh could not be started at all (the message then carries the spawn error). */
    readonly exitCode: number,
    detail: string,
  ) {
    const d = detail.trim();
    super(exitCode < 0 ? `${host}: ${d}` : `${host}: ssh exited ${exitCode}${d ? `: ${d}` : ""}`);
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
