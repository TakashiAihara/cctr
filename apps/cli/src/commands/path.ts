import type { Command } from "commander";
import { hostOf, resolveHosts } from "../hosts";
import { CliError, EXIT_NOT_FOUND } from "../output";

/** cchist compat: the session's cwd as a bare line, for `cd "$(cctr path latest)"`. */
export function registerPath(program: Command): void {
  program
    .command("path <id>")
    .description("print the cwd a session ran in (bare, for cd)")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { host?: string };
      const m = await resolveHosts(hostOf(g.host, id)).getSession(id);
      if (!m) throw new CliError(`session not found: ${id}`, EXIT_NOT_FOUND);
      if (!m.cwd) throw new CliError(`session ${m.id} has no cwd recorded`, EXIT_NOT_FOUND);
      process.stdout.write(m.cwd + "\n");
    });
}
