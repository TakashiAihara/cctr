import { blocks } from "./session";
import type { CountKind, Record } from "./types";

export const COUNT_KINDS: readonly CountKind[] = ["bash", "bash-full", "files", "slash", "skill", "hour"];

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const COMMAND_TAG = /<command-name>([^<]*)<\/command-name>/g;

export class UnknownCountKindError extends Error {
  constructor(readonly kind: string) {
    super(`unknown count kind: ${kind} (known: ${COUNT_KINDS.join(", ")})`);
  }
}

export function isCountKind(k: string): k is CountKind {
  return (COUNT_KINDS as readonly string[]).includes(k);
}

/** The keys one record adds to a count of this kind; a key may repeat. */
export function countKeys(rec: Record, kind: CountKind): string[] {
  switch (kind) {
    case "bash":
      return bashCommands(rec).map(firstWord);
    case "bash-full":
      return bashCommands(rec).map((c) => c.trim());
    case "files":
      return toolInputs(rec, (n) => EDIT_TOOLS.has(n)).flatMap((i) => {
        const p = i.file_path ?? i.notebook_path;
        return typeof p === "string" ? [p] : [];
      });
    case "slash":
      return slashCommands(rec);
    case "skill":
      return toolInputs(rec, (n) => n === "Skill").map((i) =>
        typeof i.skill === "string" && i.skill ? i.skill.replace(/^\//, "") : "?",
      );
    case "hour": {
      const t = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      return Number.isNaN(t) ? [] : [new Date(t).toISOString().slice(0, 13)];
    }
    default:
      throw new UnknownCountKindError(kind);
  }
}

/** Leading command word, skipping `FOO=bar` env prefixes. */
export function firstWord(cmd: string): string {
  const parts = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i]!)) i++;
  return parts[i] || "?";
}

function toolInputs(rec: Record, name: (n: string) => boolean): globalThis.Record<string, unknown>[] {
  if (rec.type !== "assistant") return [];
  return blocks(rec.message?.content)
    .filter((b) => b.type === "tool_use" && typeof b.name === "string" && name(b.name))
    .map((b) => (b.input && typeof b.input === "object" ? (b.input as globalThis.Record<string, unknown>) : {}));
}

function bashCommands(rec: Record): string[] {
  return toolInputs(rec, (n) => n === "Bash").flatMap((i) => (typeof i.command === "string" ? [i.command] : []));
}

function slashCommands(rec: Record): string[] {
  if (rec.type !== "user" || rec.isMeta) return [];
  const c = rec.message?.content;
  const text =
    typeof c === "string"
      ? c
      : blocks(c)
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n");
  return [...text.matchAll(COMMAND_TAG)].map((m) => m[1]!.trim().replace(/^\//, "")).filter(Boolean);
}
