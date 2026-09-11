import type { Command } from "commander";
import { resolveHosts } from "../hosts";
import { json, log } from "../output";

export function registerMeta(program: Command): void {
  program
    .command("meta")
    .description("what this cctr (or --host) knows about itself")
    .action(async (_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { host?: string };
      const sources = resolveHosts(g.host).sources;
      const results = await Promise.allSettled(sources.map((s) => s.meta()));
      // alias last: a remote reached over SSH answers with its own CLI's `alias: "local"`
      const out = results.map((r, i) =>
        r.status === "fulfilled"
          ? { ...r.value, alias: sources[i]!.host }
          : { alias: sources[i]!.host, error: String(r.reason instanceof Error ? r.reason.message : r.reason) },
      );
      for (const o of out) if ("error" in o) log(`cctr: ${o.alias}: ${o.error}`);
      json(out.length === 1 ? out[0] : out);
      if (out.some((o) => "error" in o)) process.exitCode = 1;
    });
}
