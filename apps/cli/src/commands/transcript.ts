import type { Command } from "commander";
import {
  type Msg,
  type SessionMeta,
  approxTokens,
  collectMessages,
  inAnyRange,
  msgSummary,
  parseRange,
} from "@cctr/core";
import { hostOf, resolveHosts } from "../hosts";
import { DEFAULT_BUDGET, type Parts, msgJson, parseBudget, toolLine } from "../msgs";
import { CliError, EXIT_NOT_FOUND, fmtTs, json } from "../output";

type Common = { host?: string; format?: string };
type BudgetOpt = { budget?: string | boolean };

export function registerTranscript(program: Command): void {
  program
    .command("show <id>")
    .description("one session: its metadata and the conversation (JSON by default; --format table to read it)")
    .option("--tools", "include tool calls")
    .option("--tool-results", "include tool results (JSON; the table never shows them)")
    .option("--thinking", "include thinking blocks")
    .action(async (id: string, opts: Parts, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      const { session, msgs } = await load(id, g);
      if (g.format === "table") return console.log(renderShow(session, msgs, opts));
      json({ session, messages: msgs.map((m) => msgJson(m, opts)) });
    });

  program
    .command("outline <id>")
    .description("one line per message: index, role, time, what it said or did")
    .option("--budget <n>", "approximate output tokens for --format table", String(DEFAULT_BUDGET))
    .option("--no-budget", "no output budget")
    .action(async (id: string, opts: BudgetOpt, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      const budget = parseBudget(opts.budget);
      const { msgs } = await load(id, g);
      if (g.format !== "table")
        return json(
          msgs.map((m) => ({
            index: `m${m.index}`,
            role: m.role,
            ts: m.ts,
            tools: m.tools.map((t) => t.name),
            summary: msgSummary(m, 200),
          })),
        );
      let spent = 0;
      for (const [i, m] of msgs.entries()) {
        const line = `m${m.index}\t${m.role === "user" ? "▶ user" : "● assistant"}\t${fmtTs(m.ts)}\t${msgSummary(m)}`;
        spent += approxTokens(line);
        if (spent > budget) return console.log(`… (${msgs.length - i} more messages; raise --budget or --no-budget)`);
        console.log(line);
      }
    });

  program
    .command("read <id> [ranges...]")
    .description("messages by range (m3, 3, m3..m7, 3..7; default all), in transcript order, within a token budget")
    .option("--budget <n>", "approximate output tokens for --format table", String(DEFAULT_BUDGET))
    .option("--no-budget", "no output budget")
    .option("--tools", "include tool calls")
    .option("--tool-results", "include tool results")
    .option("--thinking", "include thinking blocks")
    .action(async (id: string, args: string[], opts: Parts & BudgetOpt & { toolResults?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Common;
      // ranges first, so a typo is a usage error even when the session does not exist
      const ranges = args.map((a) => {
        const r = parseRange(a);
        if (!r) throw new CliError(`invalid range: ${a} (use m3, 3, m3..m7 or 3..7)`, 2);
        return r;
      });
      const budget = parseBudget(opts.budget);
      const { msgs } = await load(id, g);
      const picked = msgs.filter((m) => inAnyRange(m.index, ranges));
      if (picked.length === 0 && ranges.length) throw new CliError("no messages in the given range(s)", EXIT_NOT_FOUND);
      if (g.format !== "table") return json(picked.map((m) => msgJson(m, opts)));
      let spent = 0;
      for (const [i, m] of picked.entries()) {
        const block = renderRead(m, opts);
        spent += approxTokens(block);
        // the first block always prints, so a budget smaller than one message still shows something
        if (spent > budget && i > 0)
          return console.log(
            `\n… (budget ${budget} reached; ${picked.length - i} more — raise --budget or --no-budget)`,
          );
        console.log((i ? "\n" : "") + block);
      }
    });
}

async function load(id: string, g: Common): Promise<{ session: SessionMeta; msgs: Msg[] }> {
  const src = resolveHosts(hostOf(g.host, id));
  const session = await src.getSession(id);
  if (!session) throw new CliError(`session not found: ${id}`, EXIT_NOT_FOUND);
  // the host and id just resolved: `latest` or a prefix resolved again could name another session
  return { session, msgs: await collectMessages(src.readSession(`${session.host}:${session.id}`)) };
}

function renderShow(s: SessionMeta, msgs: Msg[], opts: Parts): string {
  const out = [`${s.host}:${s.id}\ncwd: ${s.cwd ?? "-"}\ntitle: ${s.title ?? "-"}`];
  for (const m of msgs) {
    if (m.role === "user") {
      if (!m.isToolResult && m.text) out.push(`▶ user\n${m.text}`);
      continue;
    }
    if (m.text) out.push(`● assistant\n${m.text}`);
    if (opts.thinking) for (const t of m.thinking) out.push(`~ thinking\n${t}`);
    if (opts.tools) for (const t of m.tools) out.push(toolLine(t.name, t.input, 200));
  }
  return out.join("\n\n");
}

function renderRead(m: Msg, opts: Parts & { toolResults?: boolean }): string {
  const parts = [`── m${m.index} ${m.role}${m.ts ? ` ${fmtTs(m.ts, true)}` : ""} ──`];
  if (m.isToolResult) {
    parts.push(opts.toolResults ? m.text || "(empty tool result)" : "(tool result — pass --tool-results to show)");
    return parts.join("\n");
  }
  if (m.text) parts.push(m.text);
  if (opts.thinking) for (const t of m.thinking) parts.push(`~ thinking\n${t}`);
  if (opts.tools) for (const t of m.tools) parts.push(toolLine(t.name, t.input));
  return parts.join("\n");
}
