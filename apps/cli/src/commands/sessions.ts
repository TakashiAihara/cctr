import type { Command } from "commander";
import type { SessionMeta } from "@cctr/core";
import { hostOf, resolveHosts } from "../hosts";
import { CliError, EXIT_NOT_FOUND, fmtK, json, log, table, trunc } from "../output";

type Common = { host?: string; format?: string };

export function registerSessions(program: Command): void {
  const sessions = program.command("sessions").description("list and read sessions");

  sessions
    .command("list")
    .description("sessions, newest first (JSON by default)")
    .option("--limit <n>", "at most n sessions", "20")
    .option("--since <iso>", "only sessions active since this time")
    .option("--cwd <path>", "only sessions whose cwd is exactly this path")
    .option("--local", "shorthand for --cwd $PWD")
    .action(async (opts: Common & { limit: string; since?: string; cwd?: string; local?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      const limit = Number.parseInt(opts.limit, 10);
      if (!(Number.isInteger(limit) && limit > 0)) throw new CliError("--limit must be a positive integer", 2);
      const cwd = opts.local ? process.cwd() : opts.cwd;
      const { sessions: metas, errors } = await resolveHosts(g.host).listSessions({ limit, since: opts.since, cwd });
      for (const e of errors) log(`cctr: ${e.host}: ${e.error}`);
      if (g.format === "table")
        return console.log(table(["host", "id", "last", "cwd", "turns", "out", "title"], metas.map(row)));
      json(metas);
      if (errors.length && metas.length === 0) process.exitCode = 1;
    });

  sessions
    .command("latest")
    .description("the most recently active session (bare id; --format json for the whole record)")
    .action(async (_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      const { sessions: metas, errors } = await resolveHosts(g.host).listSessions({ limit: 1 });
      for (const e of errors) log(`cctr: ${e.host}: ${e.error}`);
      const m = metas[0];
      // every host failing is a transport error (exit 1), not "no sessions" (exit 3)
      if (!m && errors.length) throw new CliError("no host answered", 1);
      if (!m) throw new CliError("no sessions found", EXIT_NOT_FOUND);
      if (g.format === "table" || g.format === "id")
        return console.log(m.host === "local" ? m.id : `${m.host}:${m.id}`);
      json(m);
    });

  sessions
    .command("get <id>")
    .description("one session's metadata; id may be a unique prefix, `latest`, or `host:id`")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      const m = await resolveHosts(hostOf(g.host, id)).getSession(id);
      if (!m) throw new CliError(`session not found: ${id}`, EXIT_NOT_FOUND);
      json(m);
    });

  sessions
    .command("records <id>")
    .description("the session's raw transcript records as NDJSON")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      const src = resolveHosts(hostOf(g.host, id));
      if (!(await src.getSession(id))) throw new CliError(`session not found: ${id}`, EXIT_NOT_FOUND);
      for await (const r of src.readSession(id)) process.stdout.write(JSON.stringify(r.raw) + "\n");
    });
}

function row(m: SessionMeta): string[] {
  return [
    m.host,
    m.id,
    m.lastTs?.replace("T", " ").slice(0, 16) ?? "-",
    trunc(m.cwd ?? "-", 28, "left"),
    String(m.userTurns),
    fmtK(m.usage.output),
    trunc(m.title ?? m.lastPrompt ?? "-", 44),
  ];
}
