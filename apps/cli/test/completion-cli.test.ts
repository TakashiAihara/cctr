import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const run = (args: string[]) => {
  const p = Bun.spawnSync(["bun", CLI, ...args]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

describe("cctr completion", () => {
  test("bash and zsh scripts parse, list the subcommands, and offer the global options", () => {
    for (const shell of ["bash", "zsh"]) {
      const r = run(["completion", shell]);
      expect(r.code).toBe(0);
      for (const word of ["sessions", "remote", "agent", "--host", "--format", "--limit"])
        expect(r.out).toContain(word);
      const check = Bun.spawnSync([shell, "-n"], { stdin: new TextEncoder().encode(r.out) });
      expect(check.exitCode).toBe(0);
    }
    expect(run(["completion", "fish"]).out).toContain("complete -c cctr");
  });

  test("an unknown shell is exit 2", () => {
    expect(run(["completion", "pwsh"]).code).toBe(2);
  });
});
