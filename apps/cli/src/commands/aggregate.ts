import type { Command } from "commander";
import { type CountKind, type CountResult, type SessionMeta, isCountKind } from "@cctr/core";
import { resolveHosts } from "../hosts";
import { CliError, EXIT_NOT_FOUND, fmtK, json, log, table, trunc } from "../output";

type Common = { host?: string; format?: string };
type Filter = { cwd?: string; local?: boolean; since?: string };

const STATS_BY = ["session", "day", "repo", "model"] as const;
const SOURCES = ["slash", "tool", "all"] as const;

/** cchist's aggregate commands. Session-level ones come from the session list; record-level ones from each host's Count. */
export function registerAggregates(program: Command): void {
  filtered(program.command("tokens").description("token totals across sessions")).action(
    async (opts: Filter, cmd: Command) => {
      const g = globals(cmd);
      const metas = await sessions(g, opts);
      const tot = { sessions: metas.length, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      for (const m of metas) {
        tot.input += m.usage.input;
        tot.output += m.usage.output;
        tot.cacheRead += m.usage.cacheRead;
        tot.cacheCreate += m.usage.cacheCreate;
      }
      if (g.format !== "table") return json(tot);
      console.log(
        table(
          ["metric", "value"],
          Object.entries(tot).map(([k, v]) => [k, v.toLocaleString("en-US")]),
        ),
      );
    },
  );

  filtered(program.command("stats").description("sessions grouped by session, day, repo or model"))
    .option("--by <key>", `group by: ${STATS_BY.join("|")}`, "session")
    .action(async (opts: Filter & { by: string }, cmd: Command) => {
      const g = globals(cmd);
      const by = oneOf(opts.by, STATS_BY, "--by");
      const groups = new Map<string, StatsRow>();
      for (const m of await sessions(g, opts)) {
        const k = statsKey(m, by);
        const r = groups.get(k) ?? {
          key: k,
          sessions: 0,
          turns: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
          tools: 0,
        };
        r.sessions++;
        r.turns += m.userTurns;
        r.input += m.usage.input;
        r.output += m.usage.output;
        r.cacheRead += m.usage.cacheRead;
        r.cacheCreate += m.usage.cacheCreate;
        r.tools += Object.values(m.tools).reduce((s, n) => s + n, 0);
        groups.set(k, r);
      }
      const rows = [...groups.values()].sort((a, b) => b.output - a.output || a.key.localeCompare(b.key));
      if (g.format !== "table") return json(rows);
      console.log(
        table(
          [by, "sess", "turns", "in", "out", "cacheR", "cacheW", "tools"],
          rows.map((r) => [
            // session keys stay whole so they can be pasted into other commands
            by === "session" ? r.key : trunc(r.key, 30, by === "repo" ? "left" : "right"),
            String(r.sessions),
            String(r.turns),
            fmtK(r.input),
            fmtK(r.output),
            fmtK(r.cacheRead),
            fmtK(r.cacheCreate),
            String(r.tools),
          ]),
        ),
      );
    });

  filtered(program.command("tools").description("tool calls across sessions"))
    .option("--expand-skills", "split Skill into Skill:<name>")
    .action(async (opts: Filter & { expandSkills?: boolean }, cmd: Command) => {
      const g = globals(cmd);
      const counts: Counts = {};
      for (const m of await sessions(g, opts))
        for (const [name, n] of Object.entries(m.tools))
          if (!(opts.expandSkills && name === "Skill")) add(counts, name, n);
      if (opts.expandSkills)
        for (const [name, n] of Object.entries((await count(g, opts, "skill")).counts)) add(counts, `Skill:${name}`, n);
      shares(g, ["tool", "count", "share"], counts, Infinity, (k) => k);
    });

  filtered(program.command("bash").description("most-used Bash commands (leading word; --full for the whole command)"))
    .option("--top <n>", "max rows", "25")
    .option("--full", "group by the whole command instead of its leading word")
    .action(async (opts: Filter & { top: string; full?: boolean }, cmd: Command) => {
      const g = globals(cmd);
      const top = positive(opts.top, "--top");
      const { counts } = await count(g, opts, opts.full ? "bash-full" : "bash");
      // a row is one line, so a multi-line command shows where it breaks; JSON keeps the newlines
      shares(g, ["command", "count", "share"], counts, top, (k) => trunc(k.replaceAll("\n", "⏎"), 60));
    });

  filtered(program.command("files").description("most-edited files (Edit / Write / MultiEdit / NotebookEdit)"))
    .option("--top <n>", "max rows", "30")
    .action(async (opts: Filter & { top: string }, cmd: Command) => {
      const g = globals(cmd);
      const top = positive(opts.top, "--top");
      const rows = sorted((await count(g, opts, "files")).counts).slice(0, top);
      if (g.format !== "table") return json(Object.fromEntries(rows));
      console.log(
        table(
          ["file", "edits"],
          rows.map(([k, n]) => [trunc(k, 64, "left"), String(n)]),
        ),
      );
    });

  filtered(program.command("commands").description("slash commands typed and skills run"))
    .option("--top <n>", "max rows", "30")
    .option("--source <s>", `${SOURCES.join("|")}: typed /commands, Skill tool calls, or both`, "all")
    .action(async (opts: Filter & { top: string; source: string }, cmd: Command) => {
      const g = globals(cmd);
      const top = positive(opts.top, "--top");
      const source = oneOf(opts.source, SOURCES, "--source");
      const counts: Counts = {};
      if (source !== "tool")
        for (const [k, n] of Object.entries((await count(g, opts, "slash")).counts)) add(counts, k, n);
      if (source !== "slash")
        for (const [k, n] of Object.entries((await count(g, opts, "skill")).counts)) if (k !== "?") add(counts, k, n);
      const rows = sorted(counts).slice(0, top);
      if (g.format !== "table") return json(Object.fromEntries(rows));
      console.log(
        table(
          ["command", "count"],
          rows.map(([k, n]) => [k, String(n)]),
        ),
      );
    });

  filtered(program.command("activity").description("active time and an hour-of-day histogram (local time)")).action(
    async (opts: Filter, cmd: Command) => {
      const g = globals(cmd);
      const r = await count(g, opts, "hour");
      if (r.sessions === 0) throw new CliError("no sessions found", EXIT_NOT_FOUND);
      const byHour = Array.from({ length: 24 }, () => 0);
      // buckets are UTC hours so every host agrees; the local hour is this machine's
      for (const [bucket, n] of Object.entries(r.counts)) byHour[new Date(`${bucket}:00:00Z`).getHours()]! += n;
      if (g.format !== "table") return json({ sessions: r.sessions, records: r.records, activeMs: r.activeMs, byHour });
      const max = Math.max(...byHour, 1);
      console.log(`sessions: ${r.sessions}   active: ${duration(r.activeMs)}   records: ${r.records}`);
      console.log("\nhour-of-day (local time):");
      for (const [h, n] of byHour.entries())
        console.log(
          `${String(h).padStart(2, "0")}  ${String(n).padStart(6)}  ${"█".repeat(Math.round((n / max) * 40))}`,
        );
    },
  );

  filtered(
    program
      .command("count <kind>")
      .description("one raw count over records, as JSON (what remotes are asked over SSH)"),
  ).action(async (kind: string, opts: Filter, cmd: Command) => {
    if (!isCountKind(kind)) throw new CliError(`unknown count kind: ${kind}`, 2);
    json(await count(globals(cmd), opts, kind));
  });
}

type StatsRow = {
  key: string;
  sessions: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  tools: number;
};

type Counts = { [key: string]: number };

function filtered(c: Command): Command {
  return c
    .option("--cwd <path>", "only sessions whose cwd is exactly this path")
    .option("--local", "shorthand for --cwd $PWD")
    .option("--since <iso>", "only sessions active since this time");
}

function globals(cmd: Command): Common {
  return cmd.optsWithGlobals() as Common;
}

function cwdOf(f: Filter): string | undefined {
  return f.local ? process.cwd() : f.cwd;
}

async function sessions(g: Common, f: Filter): Promise<SessionMeta[]> {
  const { sessions: metas, errors } = await resolveHosts(g.host).listSessions({ cwd: cwdOf(f), since: f.since });
  report(errors, metas.length === 0);
  return metas;
}

async function count(g: Common, f: Filter, kind: CountKind): Promise<CountResult> {
  const src = resolveHosts(g.host);
  const { result, errors } = await src.count({ kind, cwd: cwdOf(f), since: f.since });
  report(errors, errors.length === src.sources.length);
  return result;
}

/** Host errors go to stderr; only every host failing is a failure of the command. */
function report(errors: { host: string; error: string }[], fatal: boolean): void {
  for (const e of errors) log(`cctr: ${e.host}: ${e.error}`);
  if (errors.length && fatal) throw new CliError("no host answered", 1);
}

function statsKey(m: SessionMeta, by: (typeof STATS_BY)[number]): string {
  if (by === "day") return m.lastTs?.slice(0, 10) ?? "?";
  if (by === "repo") return m.cwd ?? "?";
  if (by === "model") return m.models.join(",") || "?";
  return m.host === "local" ? m.id : `${m.host}:${m.id}`;
}

function add(c: Counts, k: string, n: number): void {
  c[k] = (c[k] ?? 0) + n;
}

function sorted(c: Counts): [string, number][] {
  return Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The top rows, each with its share of everything counted, not only of the rows shown. */
function shares(g: Common, headers: string[], counts: Counts, top: number, label: (k: string) => string): void {
  const rows = sorted(counts).slice(0, top);
  if (g.format !== "table") return json(Object.fromEntries(rows));
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  console.log(
    table(
      headers,
      rows.map(([k, n]) => [label(k), String(n), total ? `${((n / total) * 100).toFixed(1)}%` : "-"]),
    ),
  );
}

function oneOf<T extends string>(v: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new CliError(`${flag} must be one of ${allowed.join(", ")}, got ${JSON.stringify(v)}`, 2);
}

function positive(v: string, flag: string): number {
  const n = Number(v);
  if (!(Number.isInteger(n) && n > 0)) throw new CliError(`${flag} must be a positive integer`, 2);
  return n;
}

function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
