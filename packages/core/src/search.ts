import { blocks } from "./session";
import type { Record, SearchHit, SearchQuery } from "./types";

/** Chars kept either side of a match in an excerpt, unless the query says otherwise. */
export const DEFAULT_CONTEXT = 60;

/**
 * The searchable text of one content block, with the side it came from. `text` is
 * the block verbatim (collapsed only when an excerpt is cut from it); a `tool_use`
 * block is searched as its name and the string values of its input, one per line,
 * which is where a command, a path or a file body actually lives.
 */
export type SearchBlock = { role: SearchHit["role"]; kind: SearchHit["kind"]; text: string };

/** A compiled query: does this text match, and where. */
export type Matcher = (text: string) => { start: number; end: number } | null;

/**
 * Compile a query once. Both forms are regexes: a substring is escaped first, and
 * without `caseSensitive` both get /iu, so case folding is Unicode's simple folding
 * either way. A regex that does not compile is refused here, before any file is
 * read, so a typo cannot masquerade as a session with no hits.
 */
export function compileMatcher(q: SearchQuery): Matcher {
  if (q.query === "") throw new InvalidRegexError(q.query, "an empty query matches everything");
  let re: RegExp;
  try {
    re = new RegExp(q.regex ? q.query : escapeRegex(q.query), q.caseSensitive ? "u" : "iu");
  } catch (e) {
    throw new InvalidRegexError(q.query, e);
  }
  return (text) => {
    const m = re.exec(text);
    return m ? { start: m.index, end: m.index + m[0].length } : null;
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A test on the raw JSONL line that only rules lines out: a substring that JSON
 * writes unescaped appears verbatim in any line holding it. This leans on the
 * writer leaving non-ASCII unescaped, as JSON.stringify does. A regex, or a query
 * with a quote, backslash or control char (escaped on disk), gets no prefilter; so
 * does nothing that could span two tool input values, since those are joined by a
 * newline and a newline in the query is escaped on disk.
 */
export function linePrefilter(q: SearchQuery): ((line: string) => boolean) | undefined {
  if (q.regex || q.query === "" || JSON.stringify(q.query) !== `"${q.query}"`) return undefined;
  if (q.caseSensitive) return (line) => line.includes(q.query);
  const match = compileMatcher(q);
  // a run of caseless chars (CJK, digits, punctuation) is found by a plain includes,
  // much cheaper than the folding regex, which then only runs on the lines left
  const anchor = caselessRun(q.query);
  return anchor.length >= 2 ? (s) => s.includes(anchor) && match(s) !== null : (s) => match(s) !== null;
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
    super(source === "" ? "empty query" : `invalid regex: ${source}`, { cause });
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

/**
 * The name first, then every string in the input as written, so a query is typed
 * the way the command or text reads rather than as JSON with escaped quotes.
 */
function toolText(b: globalThis.Record<string, unknown>): string {
  const name = typeof b.name === "string" ? b.name : "?";
  return [name, ...strings(b.input)].join("\n");
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

/** One hit per matching block, in file order, located in the block as written. */
export function blockHits(rec: Record, q: SearchQuery, match: Matcher): SearchHit[] {
  const context = q.context ?? DEFAULT_CONTEXT;
  const out: SearchHit[] = [];
  for (const b of searchBlocks(rec, q)) {
    const at = match(b.text);
    if (!at) continue;
    out.push({
      uuid: rec.uuid ?? null,
      ts: rec.timestamp ?? null,
      role: b.role,
      kind: b.kind,
      excerpt: excerpt(b.text, at.start, at.end, context),
    });
  }
  return out;
}

/**
 * The match with `context` chars either side, on one line: whitespace runs become
 * one space after the cut, so a match spanning a newline stays where it was found.
 * Cut edges are marked with an ellipsis and never split a surrogate pair.
 */
function excerpt(text: string, start: number, end: number, context: number): string {
  let from = Math.max(0, start - context);
  let to = Math.min(text.length, end + context);
  if (from > 0 && isLow(text.charCodeAt(from))) from--;
  if (to < text.length && isLow(text.charCodeAt(to))) to++;
  const body = text.slice(from, to).replace(/\s+/g, " ");
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}
