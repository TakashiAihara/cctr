import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { existsSync, unlinkSync } from "node:fs";
import type { Command } from "commander";
import { createApp } from "@cctr/agent";
import { agentStatePath, hostToken, loadAgentState, saveAgentState, type AgentState } from "../config";
import { localSource } from "../hosts";
import { CliError, json, log } from "../output";
import { VERSION } from "../version";

const DEFAULT_PORT = 7411;

export function registerAgent(program: Command): void {
  const agent = program
    .command("agent")
    .description("the HTTP process other machines read this one's transcripts through");

  agent
    .command("run")
    .description("serve in the foreground")
    .option("--port <n>", "port", String(DEFAULT_PORT))
    .option(
      "--bind <addr>",
      "listen address; anything but 127.0.0.1 exposes the transcripts to that network",
      "127.0.0.1",
    )
    .action(async (opts: { port: string; bind: string }) => {
      const port = parsePort(opts.port);
      const token = hostToken();
      const app = createApp({ source: localSource(), token });
      const server = Bun.serve({ hostname: opts.bind, port, fetch: app.fetch });
      const st: AgentState = {
        pid: process.pid,
        bind: opts.bind,
        port: server.port ?? port,
        token,
        startedAt: new Date().toISOString(),
        version: VERSION,
      };
      saveAgentState(st);
      log(`cctr agent: listening on http://${opts.bind}:${st.port} (pid ${process.pid})`);
      if (opts.bind !== "127.0.0.1" && opts.bind !== "localhost") {
        log("cctr agent: bound beyond loopback; every request still needs the bearer token from `cctr agent token`");
      }
      const stop = () => {
        server.stop(true);
        clearState(st.pid);
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });

  agent
    .command("start")
    .description("start in the background and return")
    .option("--port <n>", "port", String(DEFAULT_PORT))
    .option("--bind <addr>", "listen address", "127.0.0.1")
    .action(async (opts: { port: string; bind: string }) => {
      const running = await liveState();
      if (running)
        throw new CliError(`agent already running (pid ${running.pid}, http://${running.bind}:${running.port})`, 1);
      const port = parsePort(opts.port);
      // the token is about to be offered to whatever answers at bind:port, so bind must be
      // an address of this machine, never a name or an address somewhere else
      if (!isLocalBind(opts.bind)) throw new CliError(`--bind must be an address of this machine; got ${opts.bind}`, 2);
      if (port !== 0) {
        // the state file can be gone while an agent still holds the port (a crash of the CLI
        // that started it, a second start racing this one); take it back rather than spawn a
        // child that fails to bind and dies unseen
        const orphan = await metaOf({ bind: opts.bind, port, token: hostToken() } as AgentState);
        if (orphan?.name === "cctr" && typeof orphan.pid === "number") {
          const st: AgentState = {
            pid: orphan.pid,
            bind: opts.bind,
            port,
            token: hostToken(),
            startedAt: new Date().toISOString(),
            version: VERSION,
          };
          saveAgentState(st);
          json({ pid: st.pid, url: `http://${probeHost(st.bind)}:${st.port}`, startedAt: st.startedAt, adopted: true });
          return;
        }
        if (await portInUse(opts.bind, port))
          throw new CliError(`port ${port} is in use by something that is not this host's cctr agent`, 1);
      }
      const [cmd, args] = selfCommand(["agent", "run", "--port", String(port), "--bind", opts.bind]);
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.unref();
      // the child writes its state file once it is listening; wait for that rather than trusting the spawn
      const st = await waitFor(() => liveState(), 5000);
      if (!st) {
        // between the port check and the child's bind someone else may have taken the port
        if (port !== 0 && (await portInUse(opts.bind, port))) {
          throw new CliError(`port ${port} was taken by another process before the agent could bind`, 1);
        }
        throw new CliError("agent did not come up within 5s", 1);
      }
      json({ pid: st.pid, url: `http://${probeHost(st.bind)}:${st.port}`, startedAt: st.startedAt });
    });

  agent
    .command("stop")
    .description("stop the background agent")
    .action(async () => {
      const st = await liveState();
      if (!st) {
        clearState();
        throw new CliError("agent is not running", 1);
      }
      process.kill(st.pid, "SIGTERM");
      const gone = await waitFor(async () => ((await liveState()) ? null : true), 5000);
      if (!gone) throw new CliError(`agent (pid ${st.pid}) did not stop within 5s`, 1);
      clearState();
      json({ stopped: st.pid });
    });

  agent
    .command("status")
    .description("is the agent up, and does it answer")
    .action(async () => {
      const st = await liveState();
      if (!st) {
        json({ running: false });
        process.exitCode = 1;
        return;
      }
      json({
        running: true,
        pid: st.pid,
        url: `http://${probeHost(st.bind)}:${st.port}`,
        startedAt: st.startedAt,
        version: st.version,
      });
    });

  agent
    .command("token")
    .description(
      "print this host's bearer token (hand it to `cctr remote add --token` on the machine that will read from here)",
    )
    .action(() => {
      process.stdout.write(hostToken() + "\n");
    });
}

/** Bind and release once; only EADDRINUSE means someone else has it, any other bind error is the caller's. */
async function portInUse(bind: string, port: number): Promise<boolean> {
  try {
    const srv = Bun.serve({ hostname: bind, port, fetch: () => new Response("") });
    srv.stop(true);
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") return true;
    throw e;
  }
}

/** Loopback, a wildcard, or an address one of this machine's interfaces has. Names are not accepted. */
export function isLocalBind(bind: string, ifaces = networkInterfaces()): boolean {
  if (bind === "0.0.0.0" || bind === "::" || bind === "localhost" || bind === "::1") return true;
  if (isIP(bind) === 0) return false;
  if (bind.startsWith("127.")) return true;
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) if (i.address === bind || i.address.split("%")[0] === bind) return true;
  }
  return false;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** GetMeta as a plain Connect JSON POST: no client to build for a liveness probe. */
async function metaOf(st: AgentState): Promise<{ name?: string; pid?: number } | null> {
  try {
    const res = await fetch(`http://${probeHost(st.bind)}:${st.port}/cctr.v1.TranscriptService/GetMeta`, {
      method: "POST",
      headers: { authorization: "Bearer " + st.token, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? ((await res.json()) as { name?: string; pid?: number }) : null;
  } catch {
    return null;
  }
}

/** State file + the process answering /meta with the token and our pid. A stale file (crash, reboot) reads as not running. */
async function liveState(): Promise<AgentState | null> {
  const st = loadAgentState();
  if (!st) return null;
  // the recorded process must exist before the token goes anywhere: after a crash, whoever
  // took the port must not be handed a Bearer header just to be asked who it is
  if (!alive(st.pid)) return null;
  // and a different process that happens to own the port must not be taken for our agent
  const body = await metaOf(st);
  return body?.name === "cctr" && body.pid === st.pid ? st : null;
}

/** The agent removes its own state on SIGTERM and `stop` removes it too; whoever is second finds it gone. */
/** Where to reach an agent bound to `bind` from this machine: wildcards become loopback, IPv6 literals get brackets. */
export function probeHost(bind: string): string {
  if (bind === "0.0.0.0" || bind === "::" || bind === "") return "127.0.0.1";
  return bind.includes(":") ? `[${bind}]` : bind;
}

function clearState(onlyPid?: number): void {
  const p = agentStatePath();
  if (!existsSync(p)) return;
  if (onlyPid !== undefined && loadAgentState()?.pid !== onlyPid) return;
  try {
    unlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

function parsePort(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!(Number.isInteger(n) && n >= 0 && n <= 65535)) throw new CliError(`--port must be 0..65535, got ${v}`, 2);
  return n;
}

/** How to re-run ourselves: the compiled binary directly, or `bun <entry>` from source. */
function selfCommand(args: string[]): [string, string[]] {
  const entry = process.argv[1];
  const fromSource = entry !== undefined && entry.endsWith(".ts") && existsSync(entry);
  return fromSource ? [process.execPath, [entry, ...args]] : [process.execPath, args];
}

async function waitFor<T>(probe: () => Promise<T | null>, ms: number): Promise<T | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await probe();
    if (v) return v;
    await Bun.sleep(100);
  }
  return null;
}
