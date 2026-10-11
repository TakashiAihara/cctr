import { blocks } from "./session";
import type { Record, SearchHit, SearchQuery } from "./types";

/** Chars kept either side of a match in an excerpt, unless the query says otherwise. */
export const DEFAULT_CONTEXT = 60;

/**
 * The searchable text of one content block, with the side it came from. `text` is
 * the block verbatim (collapsed only when an excerpt is cut from it); a `tool_use`
 * block is searched as `name` plus its input, which is where a command or a path
 * actually lives.
 */
export type SearchBlock = { role: SearchHit["role"]; kind: SearchHit["kind"]; text: string };

/** A compiled query: does this text match, and where. */
export type Matcher = (text: string) => { start: number; end: number } | null;

/**
 * Compile a query once. A substring compares the lowercased texts unless the query
 * is case-sensitive; a regex gets the same choice as the `i` flag. A regex that
 * does not compile is refused here, before any file is read, so a typo cannot
 * masquerade as a session with no hits.
 */
export function compileMatcher(q: SearchQuery): Matcher {
  if (q.regex) {
    const flags = q.caseSensitive ? "u" : "iu";
    let re: RegExp;
    try {
      re = new RegExp(q.query, flags);
    } catch (e) {
      throw new InvalidRegexError(q.query, e);
    }
    return (text) => {
      const m = re.exec(text);
      return m ? { start: m.index, end: m.index + m[0].length } : null;
    };
  }
  const needle = q.caseSensitive ? q.query : q.query.toLowerCase();
  return (text) => {
    const i = (q.caseSensitive ? text : text.toLowerCase()).indexOf(needle);
    return i < 0 ? null : { start: i, end: i + needle.length };
  };
}

/**
 * A test on the raw JSONL line that only rules lines out: a substring that JSON
 * writes unescaped appears verbatim in any line holding it. A regex, or a query
 * with a quote, backslash or control char (escaped on disk), gets no prefilter.
 */
export function linePrefilter(q: SearchQuery): ((line: string) => boolean) | undefined {
  if (q.regex || q.query === "" || JSON.stringify(q.query) !== `"${q.query}"`) return undefined;
  if (q.caseSensitive) return (line) => line.includes(q.query);
  // lowercasing every line costs more than the parse it saves; a run of caseless chars
  // (CJK, digits, punctuation) is found by a plain includes, and a cased one by /iu
  const anchor = caselessRun(q.query);
  const re = new RegExp(q.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
  const lower = q.query.toLowerCase();
  // /iu accepts every char toLowerCase maps onto the query except U+0130 (İ lowers to two
  // chars; found by trying every code point), so only a line holding one gets the exact rule
  const full = (s: string) => re.test(s) || (s.includes("İ") && s.toLowerCase().includes(lower));
  return anchor.length >= 2 ? (s) => s.includes(anchor) && full(s) : full;
}

/** The longest stretch of the query whose chars have no case. */
function caselessRun(s: string): string {
  let best = "";
  let cur = "";
  for (const c of s) {
    if (c.toLowerCase() === c.toUpperCase()) cur += c;
    else cur = "";
    if (cur.length > best.length) best = cur;
  }
  return best;
}

export class InvalidRegexError extends Error {
  constructor(
    readonly source: string,
    cause: unknown,
  ) {
    super(`invalid regex: ${source}`, { cause });
  }
}

/**
 * The blocks of one record this query is allowed to look at. A user record is
 * searched when it carries a message and is not a meta turn; an assistant record
 * for its text, plus its thinking and tool_use blocks only when asked, since those
 * are noise for most queries. A tool_result is never searched: it is the output of
 * something else, and it would duplicate whatever produced it.
 */
export function searchBlocks(rec: Record, q: SearchQuery): SearchBlock[] {
  const content = rec.message?.content;
  if (content === undefined) return [];
  if (rec.type === "user") {
    if (rec.isMeta || q.role === "assistant") return [];
    if (typeof content === "string") return [{ role: "user", kind: "text", text: content }];
    return blocks(content)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => ({ role: "user" as const, kind: "text" as const, text: b.text as string }));
  }
  if (rec.type !== "assistant" || q.role === "user") return [];
  const out: SearchBlock[] = [];
  for (const b of blocks(content)) {
    if (b.type === "text" && typeof b.text === "string") out.push({ role: "assistant", kind: "text", text: b.text });
    else if (q.thinking && b.type === "thinking" && typeof b.thinking === "string")
      out.push({ role: "assistant", kind: "thinking", text: b.thinking });
    else if (q.tools && b.type === "tool_use") out.push({ role: "assistant", kind: "tool_use", text: toolText(b) });
  }
  return out;
}

/** The name leads, so a hit on the tool itself reads as the tool and not as its arguments. */
function toolText(b: globalThis.Record<string, unknown>): string {
  const name = typeof b.name === "string" ? b.name : "?";
  return `${name} ${JSON.stringify(b.input ?? {})}`;
}

/**
 * One hit per matching block, in file order. The excerpt is cut from the collapsed
 * text, so the match is located there too: a query that spans a newline would
 * otherwise be found on the block but not in the line it is shown as.
 */
export function blockHits(rec: Record, q: SearchQuery, match: Matcher): SearchHit[] {
  const context = q.context ?? DEFAULT_CONTEXT;
  const out: SearchHit[] = [];
  for (const b of searchBlocks(rec, q)) {
    if (!match(b.text)) continue;
    const flat = collapse(b.text);
    const at = match(flat) ?? { start: 0, end: 0 };
    out.push({
      uuid: rec.uuid ?? null,
      ts: rec.timestamp ?? null,
      role: b.role,
      kind: b.kind,
      excerpt: excerpt(flat, at.start, at.end, context),
    });
  }
  return out;
}

/** Runs of whitespace, newlines included, become one space so an excerpt stays one line. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The match with `context` chars either side, each cut edge marked with an ellipsis. */
function excerpt(text: string, start: number, end: number, context: number): string {
  const from = Math.max(0, start - context);
  const to = Math.min(text.length, end + context);
  const body = text.slice(from, to);
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}
