#!/usr/bin/env bun
import { Command, Option } from "commander";
import { registerAgent } from "./commands/agent";
import { registerCompletion } from "./commands/completion";
import { registerMeta } from "./commands/meta";
import { registerPath } from "./commands/path";
import { registerRemote } from "./commands/remote";
import { registerSearch } from "./commands/search";
import { registerSessions } from "./commands/sessions";
import { registerTranscript } from "./commands/transcript";
import { CliError, log } from "./output";
import { VERSION } from "./version";

const program = new Command("cctr")
  .description("Claude Code transcripts: search, read, measure, and visualize them, across machines")
  .version(VERSION)
  .option("--host <spec>", "local (default), a remote name, all, or a comma list")
  .addOption(
    new Option("--format <fmt>", "json, table, id (a bare id), or ndjson (search)")
      .choices(["json", "table", "id", "ndjson"])
      .default("json"),
  )
  .showHelpAfterError()
  .configureOutput({ writeErr: (s) => process.stderr.write(s) });

// usage errors from commander are exit 2, like every other CLI here
program.exitOverride((err) => {
  if (err.code === "commander.helpDisplayed" || err.code === "commander.version") process.exit(0);
  process.exit(err.exitCode === 1 ? 2 : err.exitCode);
});

registerSessions(program);
registerSearch(program);
registerTranscript(program);
registerPath(program);
registerMeta(program);
registerAgent(program);
registerRemote(program);
registerCompletion(program);

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof CliError) {
    log(`cctr: ${e.message}`);
    process.exit(e.exitCode);
  }
  log(`cctr: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
