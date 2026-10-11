import type { SessionMeta } from "@cctr/core";
import { CliError } from "./output";

/** Every key of SessionMeta, in the order the record itself carries them. */
export const META_FIELDS = [
  "id",
  "sid",
  "file",
  "host",
  "cwd",
  "gitBranch",
  "version",
  "entrypoint",
  "title",
  "lastPrompt",
  "firstTs",
  "lastTs",
  "durationMs",
  "records",
  "userTurns",
  "assistantMsgs",
  "models",
  "usage",
  "tools",
  "sizeBytes",
  "mtimeMs",
] as const satisfies readonly (keyof SessionMeta)[];

export type Field = (typeof META_FIELDS)[number];

/** A SessionMeta key the list above does not name; naming it is the only fix. */
type Unlisted = Exclude<keyof SessionMeta, Field>;
/** Compile-time guard: a key added to SessionMeta and not to the list above fails to assign here. */
const _listed: [Unlisted] extends [never] ? true : [`META_FIELDS is missing`, Unlisted] = true;

/** The named keys of a `--fields` spec, or nothing at all when the whole record was asked for. */
export function parseFields(spec: string | undefined): Field[] | undefined {
  if (spec === undefined) return undefined;
  const names = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) throw new CliError("--fields needs at least one field", 2);
  for (const [i, name] of names.entries()) {
    if (!(META_FIELDS as readonly string[]).includes(name))
      throw new CliError(`unknown field: ${name} (known: ${META_FIELDS.join(", ")})`, 2);
    if (names.indexOf(name) !== i) throw new CliError(`duplicate field: ${name}`, 2);
  }
  return names as Field[];
}

/** Only the named keys, in the order they were named. */
export function pick(m: SessionMeta, fields: readonly Field[]): globalThis.Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f, m[f]]));
}

/** A table cell. A value the session never recorded is a dash; nothing here is cut short. */
export function cell(m: SessionMeta, f: Field): string {
  const v = m[f];
  if (v === null) return "-";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
