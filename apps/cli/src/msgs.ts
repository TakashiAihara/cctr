import type { Msg } from "@cctr/core";
import { CliError, trunc } from "./output";

/** What a message command may be asked to add beyond text and tool results. */
export type Parts = { tools?: boolean; thinking?: boolean; toolResults?: boolean };

/** Approximate tokens a table prints before it cuts itself off and says so. */
export const DEFAULT_BUDGET = 6000;

/** `--no-budget` reaches here as boolean false; a value has to be a whole number of tokens. */
export function parseBudget(v: string | boolean | undefined): number {
  // commander hands over the string default or `false` for --no-budget, never `true`
  if (v === false) return Infinity;
  const n = Number(v ?? DEFAULT_BUDGET);
  if (!(Number.isInteger(n) && n > 0)) throw new CliError("--budget must be a positive integer", 2);
  return n;
}

/** Thinking, tool calls and tool output stay out unless asked for; the conversation is what is left. */
export function msgJson(m: Msg, opts: Parts) {
  return {
    index: `m${m.index}`,
    role: m.role,
    ts: m.ts,
    uuid: m.uuid,
    // tool output is most of a transcript's text, so like tools and thinking it is asked for
    text: m.isToolResult && !opts.toolResults ? "" : m.text,
    isToolResult: m.isToolResult,
    ...(opts.thinking ? { thinking: m.thinking } : {}),
    ...(opts.tools ? { tools: m.tools } : {}),
  };
}

/** The argument of a tool call is long as a rule; a listing cuts it, a transcript does not. */
export function toolLine(name: string, input: unknown, cut?: number): string {
  const arg = JSON.stringify(input);
  return `⚙ ${name} ${cut === undefined ? arg : trunc(arg, cut)}`;
}
