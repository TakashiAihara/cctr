import { describe, expect, test } from "bun:test";
import { Command, Option } from "commander";
import { buildBashCompletion, buildFishCompletion, buildZshCompletion, flattenCommands } from "../src/completion";

/** Build a tiny commander program shaped like the real cctr tree so we can
 *  unit-test the generators without dragging in the full CLI surface. */
function makeProgram(): Command {
  const program = new Command();
  program.name("xcli").description("test cli");

  // Top-level leaf with a few options including a choices option.
  program
    .command("stats")
    .description("aggregate stats")
    .option("--by <key>", "group by key", "session")
    .option("--local", "only sessions whose cwd === current dir")
    .addOption(new Option("--mode <m>", "mode").choices(["a", "b"]).default("a"));

  // Top-level leaf with no options.
  program.command("ping").description("ping");

  // Top-level with nested subcommands.
  const sessions = program.command("sessions").description("sessions group");
  sessions.command("list").description("list sessions").option("--json", "machine-readable output");
  sessions.command("latest").description("most recent session id").option("--json", "machine-readable output");

  return program;
}

describe("flattenCommands", () => {
  test("walks all non-root subcommands with full paths", () => {
    const cmds = flattenCommands(makeProgram());
    const paths = cmds.map((c) => c.path.join(" ")).sort();
    expect(paths).toEqual(["ping", "sessions", "sessions latest", "sessions list", "stats"]);
  });

  test("captures option flag, description, choices, takesValue", () => {
    const cmds = flattenCommands(makeProgram());
    const stats = cmds.find((c) => c.path.join(" ") === "stats")!;
    const by = stats.options.find((o) => o.long === "--by")!;
    expect(by.takesValue).toBe(true);
    expect(by.choices).toEqual([]);
    const mode = stats.options.find((o) => o.long === "--mode")!;
    expect(mode.takesValue).toBe(true);
    expect(mode.choices).toEqual(["a", "b"]);
    const local = stats.options.find((o) => o.long === "--local")!;
    expect(local.takesValue).toBe(false);
  });

  test("subcommands array reflects direct children only", () => {
    const cmds = flattenCommands(makeProgram());
    const sessions = cmds.find((c) => c.path.join(" ") === "sessions")!;
    expect(sessions.subcommands.sort()).toEqual(["latest", "list"]);
    const list = cmds.find((c) => c.path.join(" ") === "sessions list")!;
    expect(list.subcommands).toEqual([]);
  });
});

describe("buildBashCompletion", () => {
  const out = buildBashCompletion(flattenCommands(makeProgram()), "xcli");

  test("declares the completion function and registers it", () => {
    expect(out).toContain("_xcli() {");
    expect(out).toContain("complete -F _xcli xcli");
  });

  test("doesn't ship a dead `prev` variable", () => {
    // Reviewer flagged: `prev` was captured but never used.
    expect(out).not.toContain("prev=");
  });

  test("offers top-level subcommands in alphabetical order", () => {
    expect(out).toMatch(/COMPREPLY=\( \$\(compgen -W "ping sessions stats --help --version" -- /);
  });

  test("dispatches sessions subcommands separately", () => {
    expect(out).toContain(`"sessions"`);
    expect(out).toContain(`latest list`);
  });

  test("emits per-command option lists", () => {
    expect(out).toContain(`stats) opts="--by --local --mode --help" ;;`);
    expect(out).toContain(`ping) opts=" --help" ;;`);
    expect(out).toContain(`list) opts="--json --help" ;;`);
  });
});

describe("buildZshCompletion", () => {
  const out = buildZshCompletion(flattenCommands(makeProgram()), "xcli");

  test("starts with the compdef header", () => {
    expect(out.split("\n")[0]).toBe("#compdef xcli");
  });

  test("ends with an explicit compdef call so eval-on-init also wires up", () => {
    // `source <(cctr completion zsh)` won't honor the `#compdef` directive
    // (that's compsys-autoload-only); the trailing `compdef` is required for
    // the source-into-shell install path to actually register.
    expect(out).toContain("compdef _xcli xcli");
    expect(out).not.toMatch(/^_xcli "\$@"\s*$/m);
  });

  test("lists top-level subcommands with descriptions, sorted alphabetically", () => {
    expect(out).toContain(`'stats:aggregate stats'`);
    expect(out).toContain(`'sessions:sessions group'`);
    expect(out).toContain(`'ping:ping'`);
    expect(out.indexOf(`'ping:`)).toBeLessThan(out.indexOf(`'sessions:`));
    expect(out.indexOf(`'sessions:`)).toBeLessThan(out.indexOf(`'stats:`));
  });

  test("emits choice completion for --mode", () => {
    expect(out).toContain(`'--mode[mode]:value:(a b)'`);
  });

  test("emits boolean vs value-taking option distinction", () => {
    expect(out).toContain(`'--local[only sessions whose cwd === current dir]'`);
    expect(out).toContain(`'--by[group by key]:value:'`);
  });

  test("handles a no-option subcommand with _message", () => {
    expect(out).toContain(`_message 'no options'`);
  });

  test("escapes single-quote in descriptions via '\\'' instead of dropping", () => {
    const program = new Command();
    program.name("xcli");
    program.command("foo").description("it's a thing").option("--bar", "don't break me");
    const z = buildZshCompletion(flattenCommands(program), "xcli");
    expect(z).toContain(`'foo:it'\\''s a thing'`);
    expect(z).toContain(`'--bar[don'\\''t break me]'`);
  });

  test("escapes ] in description so it doesn't close the bracketed spec early", () => {
    const program = new Command();
    program.name("xcli");
    program.command("foo").option("--baz", "label [closed]");
    const z = buildZshCompletion(flattenCommands(program), "xcli");
    expect(z).toContain(`'--baz[label [closed\\]]'`);
  });

  test("escapes single-quote inside choices", () => {
    const program = new Command();
    program.name("xcli");
    program.command("foo").addOption(new Option("--m <m>", "mode").choices(["a", "b'c"]));
    const z = buildZshCompletion(flattenCommands(program), "xcli");
    expect(z).toContain(`'--m[mode]:value:(a b'\\''c)'`);
  });
});

describe("buildFishCompletion", () => {
  const out = buildFishCompletion(flattenCommands(makeProgram()), "xcli");

  test("emits use_subcommand entries for top level, sorted alphabetically", () => {
    expect(out).toContain(`complete -c xcli -n '__fish_use_subcommand' -a ping -d 'ping'`);
    expect(out).toContain(`complete -c xcli -n '__fish_use_subcommand' -a stats -d 'aggregate stats'`);
    expect(out.indexOf(`-a ping`)).toBeLessThan(out.indexOf(`-a sessions`));
    expect(out.indexOf(`-a sessions`)).toBeLessThan(out.indexOf(`-a stats`));
  });

  test("emits seen_subcommand_from entries for nested sessions list", () => {
    expect(out).toContain(`-a list -d 'list sessions'`);
  });

  test("emits options gated by the right subcommand context", () => {
    expect(out).toContain(`complete -c xcli -n '__fish_seen_subcommand_from stats' -l by -d 'group by key' -r`);
    expect(out).toContain(`complete -c xcli -n '__fish_seen_subcommand_from stats' -l mode -d 'mode' -x -a 'a b'`);
  });

  test("conditions go through single-quote escaping so a `'` in a subcommand name doesn't break the script", () => {
    // Subcommand names from commander are usually ASCII, but option conditions
    // are constructed strings — defensively quote them.
    const program = new Command();
    program.name("xcli");
    program.command("foo").option("--bar", "desc with ' quote");
    const f = buildFishCompletion(flattenCommands(program), "xcli");
    // The condition itself is plain (no apostrophe), but the description has
    // one and must be escaped fish-style as `\'`.
    expect(f).toContain(`-d 'desc with \\' quote'`);
  });
});
