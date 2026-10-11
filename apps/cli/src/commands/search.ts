import type { Command } from "commander";
import { compileMatcher, type SearchQuery, type SearchHit, type SessionHits } from "@cctr/core";
import { hostOf, resolveHosts } from "../hosts";
import { CliError, EXIT_NOT_FOUND, json, log, table, trunc } from "../output";

type Common = { host?: string; format?: string };

type Mode = "flat" | "group" | "files";

type Options = {
  regex?: boolean;
  case?: boolean;
  role: string;
  thinking?: boolean;
  tools?: boolean;
  context: string;
  limit: string;
  session?: string;
  group?: boolean;
  hitsPer: string;
  filesWithMatches?: boolean;
  cwd?: string;
  local?: boolean;
  since?: string;
};

export function registerSearch(program: Command): void {
  program
    .command("search <query>")
    .description("search transcript text, newest session first (JSON hits by default)")
    .option("--regex", "the query is a JavaScript regular expression (u flag: escape only what needs escaping)")
    .option("--case", "case-sensitive (default: insensitive)")
    .option("--role <role>", "whose text to search: user, assistant, or all", "all")
    .option("--thinking", "also search assistant thinking blocks")
    .option("--tools", "also search assistant tool calls")
    .option("--context <n>", "chars kept either side of a hit", "60")
    .option("--limit <n>", "at most n hits (n sessions with --group or -l)", "50")
    .option("--session <id>", "search only this session")
    .option("--group", "one entry per session with its hits, instead of one per hit")
    .option("--hits-per <n>", "hits kept per session, with --group", "2")
    .option("-l, --files-with-matches", "list the sessions that matched, no hits")
    .option("--cwd <path>", "only sessions whose cwd is exactly this path")
    .option("--local", "shorthand for --cwd $PWD")
    .option("--since <iso>", "only sessions active since this time")
    .action(async (query: string, opts: Options, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      const limit = positive(opts.limit, "--limit");
      const context = count(opts.context, "--context");
      const hitsPer = positive(opts.hitsPer, "--hits-per");
      const role = roleOf(opts.role);
      checkQuery(query, opts.regex);
      if (opts.since !== undefined && Number.isNaN(Date.parse(opts.since)))
        throw new CliError(`--since is not a date: ${opts.since}`, 2);

      const mode: Mode = opts.filesWithMatches ? "files" : opts.group ? "group" : "flat";
      const q: SearchQuery = {
        query,
        regex: opts.regex,
        caseSensitive: opts.case,
        role,
        thinking: opts.thinking,
        tools: opts.tools,
        context,
        limit,
        session: opts.session,
        cwd: opts.local ? process.cwd() : opts.cwd,
        since: opts.since,
        // flat mode keeps every hit and cuts the whole list, so no cap per session here
        hitsPerSession: mode === "files" ? 1 : mode === "group" ? hitsPer : undefined,
      };
      const src = resolveHosts(hostOf(g.host, q.session ?? ""));
      // a session nobody has is not a session without hits
      if (q.session && !(await src.getSession(q.session)))
        throw new CliError(`session not found: ${q.session}`, EXIT_NOT_FOUND);
      const { results, errors } = await src.search(q);
      for (const e of errors) log(`cctr: ${e.host}: ${e.error}`);
      if (g.format === "ndjson") await writeNdjson(results);
      else if (g.format === "id") for (const r of results) console.log(`${r.session.host}:${r.session.id}`);
      else if (g.format === "table") console.log(renderTable(mode, results, limit));
      else json(render(mode, results, limit));
      if (results.length === 0) process.exitCode = errors.length ? 1 : EXIT_NOT_FOUND;
    });
}

/** The remote path reads this: one whole SessionHits per line, ignoring the display mode. */
async function writeNdjson(results: SessionHits[]): Promise<void> {
  for (const r of results) {
    // the results are in memory already; waiting for drain keeps stdout from holding a second copy
    if (!process.stdout.write(JSON.stringify(r) + "\n")) {
      await new Promise((res) => process.stdout.once("drain", res));
    }
  }
}

function render(mode: Mode, results: SessionHits[], limit: number): unknown {
  if (mode === "files") return results.map(sessionRow);
  if (mode === "group") return results.map((r) => ({ ...sessionRow(r), hits: r.hits.map(hitRow) }));
  return results
    .flatMap((r) => r.hits.map((h) => ({ host: r.session.host, id: r.session.id, ...hitRow(h) })))
    .slice(0, limit);
}

function sessionRow(r: SessionHits) {
  return {
    host: r.session.host,
    id: r.session.id,
    cwd: r.session.cwd,
    title: r.session.title,
    lastTs: r.session.lastTs,
    total: r.total,
  };
}

function hitRow(h: SearchHit) {
  return { ts: h.ts, role: h.role, kind: h.kind, uuid: h.uuid, excerpt: h.excerpt };
}

function renderTable(mode: Mode, results: SessionHits[], limit: number): string {
  if (mode === "group") {
    const lines: string[] = [];
    for (const r of results) {
      lines.push(`${r.session.host}  ${r.session.id}  ${r.total}  ${r.session.title ?? "-"}`);
      for (const h of r.hits) lines.push(`  ${stamp(h.ts)}  ${h.role}  ${trunc(h.excerpt, 100)}`);
    }
    return lines.join("\n");
  }
  if (mode === "files")
    return table(
      ["host", "id", "total", "cwd", "title"],
      results.map((r) => [
        r.session.host,
        r.session.id,
        String(r.total),
        trunc(r.session.cwd ?? "-", 28, "left"),
        trunc(r.session.title ?? "-", 44),
      ]),
    );
  const hits = results.flatMap((r) => r.hits.map((h) => ({ session: r.session, hit: h }))).slice(0, limit);
  return table(
    ["host", "id", "ts", "role", "excerpt"],
    hits.map(({ session, hit }) => [
      session.host,
      session.id.slice(0, 8),
      stamp(hit.ts),
      hit.role,
      trunc(hit.excerpt, 100),
    ]),
  );
}

function stamp(ts: string | null): string {
  return ts?.replace("T", " ").slice(0, 16) ?? "-";
}

/** `all` is the default and means both sides; anything else must name one. */
function roleOf(v: string): SearchQuery["role"] {
  if (v === "all") return undefined;
  if (v === "user" || v === "assistant") return v;
  throw new CliError(`--role must be user, assistant or all, got ${JSON.stringify(v)}`, 2);
}

function positive(v: string, flag: string): number {
  const n = Number.parseInt(v, 10);
  if (!(Number.isInteger(n) && n > 0)) throw new CliError(`${flag} must be a positive integer`, 2);
  return n;
}

function count(v: string, flag: string): number {
  const n = Number.parseInt(v, 10);
  if (!(Number.isInteger(n) && n >= 0)) throw new CliError(`${flag} must be a non-negative integer`, 2);
  return n;
}

/** Compiled here so a bad regex or an empty query is a usage error before any host is asked. */
function checkQuery(query: string, regex: boolean | undefined): void {
  try {
    compileMatcher({ query, regex });
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), 2);
  }
}
