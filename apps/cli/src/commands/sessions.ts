import type { Command } from "commander";
import { isSid, type MultiSource, type SessionMeta, splitHost } from "@cctr/core";
import { cell, parseFields, pick } from "../fields";
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
    .option("--fields <a,b,c>", "only these SessionMeta keys, in this order")
    .action(
      async (
        opts: Common & { limit: string; since?: string; cwd?: string; local?: boolean; fields?: string },
        cmd: Command,
      ) => {
        const g = cmd.optsWithGlobals() as Common;
        const limit = Number.parseInt(opts.limit, 10);
        if (!(Number.isInteger(limit) && limit > 0)) throw new CliError("--limit must be a positive integer", 2);
        const fields = parseFields(opts.fields);
        const cwd = opts.local ? process.cwd() : opts.cwd;
        const { sessions: metas, errors } = await resolveHosts(g.host).listSessions({ limit, since: opts.since, cwd });
        for (const e of errors) log(`cctr: ${e.host}: ${e.error}`);
        if (g.format === "table") {
          const rows = fields ? metas.map((m) => fields.map((f) => cell(m, f))) : metas.map(row);
          return console.log(table(fields ?? ["host", "id", "last", "cwd", "turns", "out", "title"], rows));
        }
        json(fields ? metas.map((m) => pick(m, fields)) : metas);
        if (errors.length && metas.length === 0) process.exitCode = 1;
      },
    );

  sessions
    .command("latest")
    .description("the most recently active session (bare id; --format json for the whole record)")
    .option("--fields <a,b,c>", "only these SessionMeta keys, in this order")
    .action(async (opts: { fields?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      const fields = parseFields(opts.fields);
      const { sessions: metas, errors } = await resolveHosts(g.host).listSessions({ limit: 1 });
      for (const e of errors) log(`cctr: ${e.host}: ${e.error}`);
      const m = metas[0];
      // every host failing is a transport error (exit 1), not "no sessions" (exit 3)
      if (!m && errors.length) throw new CliError("no host answered", 1);
      if (!m) throw new CliError("no sessions found", EXIT_NOT_FOUND);
      if (g.format === "table" && fields) return console.log(table(fields, [fields.map((f) => cell(m, f))]));
      if (g.format === "table" || g.format === "id")
        return console.log(m.host === "local" ? m.id : `${m.host}:${m.id}`);
      json(fields ? pick(m, fields) : m);
    });

  sessions
    .command("get <id>")
    .description("one session's metadata; id may be a unique prefix, a sid, `latest`, or `host:id`")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      const src = resolveHosts(hostOf(g.host, id));
      const m = await src.getSession(id);
      if (!m) throw notFound(src, id);
      json(m);
    });

  sessions
    .command("records <id>")
    .description("the session's raw transcript records as NDJSON")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      const src = resolveHosts(hostOf(g.host, id));
      if (!(await src.getSession(id))) throw notFound(src, id);
      for await (const r of src.readSession(id)) {
        // a slow pipe must not make the process buffer the whole transcript
        if (!process.stdout.write(JSON.stringify(r.raw) + "\n")) {
          await new Promise((res) => process.stdout.once("drain", res));
        }
      }
    });
}

/** A sid is a name people read out loud, so a miss on one says which hosts were asked. */
function notFound(src: MultiSource, id: string): CliError {
  const { id: bare } = splitHost(id);
  if (isSid(bare)) return new CliError(`no session hashes to sid ${bare} on: ${hosts(src, id)}`, EXIT_NOT_FOUND);
  return new CliError(`session not found: ${id}`, EXIT_NOT_FOUND);
}

/** The hosts actually asked: a `host:` on the id narrows `--host` to that one. */
function hosts(src: MultiSource, id: string): string {
  return splitHost(id).host ?? src.sources.map((s) => s.host).join(", ");
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
