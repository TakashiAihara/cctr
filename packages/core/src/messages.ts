import { blocks, isToolResultOnly } from "./session";
import type { Record } from "./types";

type Block = globalThis.Record<string, unknown>;

/** One user or assistant message, numbered in file order. */
export type Msg = {
  index: number;
  role: "user" | "assistant";
  /** The record's timestamp as written, or null when it carries none. */
  ts: string | null;
  uuid: string | null;
  text: string;
  thinking: string[];
  tools: { name: string; input: unknown }[];
  isToolResult: boolean;
};

const RANGE = /^[mM]?(\d+)(?:\.\.[mM]?(\d+))?$/;

/**
 * The conversation of one session, in the order the records are written. One API
 * response is written as several assistant records, one per content block, so a
 * single reply is often several messages here.
 */
export async function collectMessages(records: AsyncIterable<Record>): Promise<Msg[]> {
  const out: Msg[] = [];
  for await (const rec of records) {
    if (!rec.message) continue;
    if (rec.type === "user" && !rec.isMeta) out.push(userMsg(out.length, rec));
    else if (rec.type === "assistant") out.push(assistantMsg(out.length, rec));
  }
  return out;
}

function userMsg(index: number, rec: Record): Msg {
  const content = rec.message?.content;
  const bs = blocks(content);
  const isToolResult = isToolResultOnly(content);
  return {
    index,
    role: "user",
    ts: rec.timestamp ?? null,
    uuid: rec.uuid ?? null,
    text:
      typeof content === "string"
        ? content
        : isToolResult
          ? bs.map(resultText).join("\n")
          : blockTexts(bs, "text").join("\n"),
    thinking: [],
    tools: [],
    isToolResult,
  };
}

function assistantMsg(index: number, rec: Record): Msg {
  const bs = blocks(rec.message?.content);
  return {
    index,
    role: "assistant",
    ts: rec.timestamp ?? null,
    uuid: rec.uuid ?? null,
    text: blockTexts(bs, "text").join("\n"),
    thinking: blockTexts(bs, "thinking"),
    tools: bs
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ name: typeof b.name === "string" ? b.name : "?", input: b.input })),
    isToolResult: false,
  };
}

/** A tool result carries a string, or the text blocks of a structured one. */
function resultText(b: Block): string {
  return typeof b.content === "string" ? b.content : blockTexts(blocks(b.content), "text").join("\n");
}

/** The string in every block of this type; a block without it contributes nothing. */
function blockTexts(bs: Block[], type: "text" | "thinking"): string[] {
  const out: string[] = [];
  for (const b of bs) {
    if (b.type !== type) continue;
    const v = b[type];
    if (typeof v === "string") out.push(v);
  }
  return out;
}

/** One line standing in for a message: what it said, else what it did, else that it did neither. */
export function msgSummary(m: Msg, width = 90): string {
  const text = m.text.replace(/\s+/g, " ").trim();
  const body =
    text ||
    (m.tools.length ? "⚙ " + m.tools.map((t) => t.name).join(", ") : m.isToolResult ? "(tool result)" : "(empty)");
  // counted in code points, so the cut never leaves half of an emoji
  const cps = Array.from(body);
  return cps.length > width ? cps.slice(0, width - 1).join("") + "…" : body;
}

/** `m3`, `3`, `m3..m7`, `3..7`: the `m` is optional per side, either case, and a reversed span is normalized. */
export function parseRange(token: string): { start: number; end: number } | null {
  const m = RANGE.exec(token);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** No ranges at all means the whole conversation. */
export function inAnyRange(n: number, ranges: { start: number; end: number }[]): boolean {
  return ranges.length === 0 || ranges.some((r) => n >= r.start && n <= r.end);
}

/** Close enough to decide what fits in a budget; not a tokenizer. */
export function approxTokens(s: string): number {
  // about four ASCII chars to a token, but a CJK char is about a token on its own
  let ascii = 0;
  let other = 0;
  for (const c of s) {
    if (c <= "\x7f") ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}
