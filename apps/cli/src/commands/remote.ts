import type { Command } from "commander";
import { isSshTarget } from "@cctr/core";
import { loadRemotes, saveRemotes, type Remote } from "../config";
import { remoteSource } from "../hosts";
import { CliError, json, log } from "../output";

export function registerRemote(program: Command): void {
  const remote = program.command("remote").description("other machines whose transcripts this cctr can read");

  remote
    .command("add <name>")
    .description("register a machine, reached over HTTP (its `cctr agent`) or SSH (its `cctr` CLI)")
    .option("--url <url>", "agent URL, e.g. http://host:7411")
    .option("--token <token>", "that host's `cctr agent token` (with --url)")
    .option("--ssh <target>", "ssh target, e.g. user@host or an ssh_config alias")
    .option(
      "--command <path>",
      "cctr binary on the remote (with --ssh; default `cctr`, which non-login shells may not find)",
    )
    .option("--no-check", "register without contacting the host")
    .action(
      async (name: string, opts: { url?: string; token?: string; ssh?: string; command?: string; check: boolean }) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "local" || name === "all") {
          throw new CliError(`bad remote name: ${name}`, 2);
        }
        let r: Remote;
        if (opts.url && !opts.ssh) {
          if (!opts.token) throw new CliError("--url needs --token (run `cctr agent token` on that host)", 2);
          r = { kind: "http", url: opts.url, token: opts.token };
          if (!isLoopbackUrl(opts.url) && new URL(opts.url).protocol === "http:") {
            log(
              `cctr: ${name}: plain http beyond loopback sends the token in the clear; prefer --ssh or a tunnel (README, "Which path")`,
            );
          }
        } else if (opts.ssh && !opts.url) {
          if (!isSshTarget(opts.ssh)) {
            throw new CliError(
              `--ssh must be user@host, host, or an ssh_config alias; got ${JSON.stringify(opts.ssh)}`,
              2,
            );
          }
          r = { kind: "ssh", target: opts.ssh, ...(opts.command ? { command: opts.command } : {}) };
        } else {
          throw new CliError("give exactly one of --url or --ssh", 2);
        }
        if (opts.check) {
          const meta = await remoteSource(name, r).meta();
          log(`cctr: ${name}: reached ${meta.host} (cctr ${meta.version}, schema ${meta.schemaVersion})`);
        }
        const remotes = loadRemotes();
        remotes[name] = r;
        saveRemotes(remotes);
        json({ name, ...describe(r) });
      },
    );

  remote
    .command("rm <name>")
    .description("forget a machine")
    .action((name: string) => {
      const remotes = loadRemotes();
      if (!remotes[name]) throw new CliError(`unknown remote: ${name}`, 3);
      delete remotes[name];
      saveRemotes(remotes);
      json({ removed: name });
    });

  remote
    .command("list")
    .description("registered machines (tokens are not printed)")
    .action(() => {
      json(Object.entries(loadRemotes()).map(([name, r]) => ({ name, ...describe(r) })));
    });

  remote
    .command("check [name]")
    .description("contact each machine (or one) and report what answered")
    .action(async (name?: string) => {
      const remotes = loadRemotes();
      const names = name ? [name] : Object.keys(remotes);
      const out: Array<Record<string, unknown>> = [];
      for (const n of names) {
        const r = remotes[n];
        if (!r) throw new CliError(`unknown remote: ${n}`, 3);
        try {
          const meta = await remoteSource(n, r).meta();
          out.push({ name: n, ok: true, host: meta.host, version: meta.version, schemaVersion: meta.schemaVersion });
        } catch (e) {
          out.push({ name: n, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      json(out);
      if (out.some((o) => !o.ok)) process.exitCode = 1;
    });
}

function describe(r: Remote): Record<string, string> {
  return r.kind === "http"
    ? { kind: "http", url: r.url }
    : { kind: "ssh", target: r.target, ...(r.command ? { command: r.command } : {}) };
}

function isLoopbackUrl(u: string): boolean {
  const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}
