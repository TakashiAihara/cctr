import type { Msg } from "@cctr/core";
import { CliError, trunc } from "./output";

/** What a message command may be asked to add beyond text and tool results. */
export type Parts = { tools?: boolean; thinking?: boolean };

/** Approximate tokens a table prints before it cuts itself off and says so. */
export const DEFAULT_BUDGET = 6000;

/** `--no-budget` reaches here as boolean false; a value has to be a whole number of tokens. */
export function parseBudget(v: string | boolean | undefined): number {
  if (typeof v === "boolean") return v ? DEFAULT_BUDGET : Infinity;
  const n = Number.parseInt(v ?? String(DEFAULT_BUDGET), 10);
  if (!(Number.isInteger(n) && n > 0)) throw new CliError("--budget must be a positive integer", 2);
  return n;
}

/** Thinking and tool calls stay out of the way unless they were asked for, so a whole session stays readable. */
export function msgJson(m: Msg, opts: Parts) {
  return {
    index: `m${m.index}`,
    role: m.role,
    ts: m.ts,
    uuid: m.uuid,
    text: m.text,
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
