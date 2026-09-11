/** stdout is data, stderr is talk: every command prints JSON unless asked for a table. */
export function json(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

export function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

export function table(headers: string[], rows: string[][]): string {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(w[i]!))
      .join("  ")
      .trimEnd();
  return [line(headers), line(w.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n");
}

export function trunc(s: string, n: number, side: "left" | "right" = "right"): string {
  if (s.length <= n) return s;
  return side === "right" ? s.slice(0, n - 1) + "…" : "…" + s.slice(-(n - 1));
}

export function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
  }
}

export const EXIT_NOT_FOUND = 3;
