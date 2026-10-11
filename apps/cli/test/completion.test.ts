import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const script = (shell: string) => Bun.spawnSync(["bun", CLI, "completion", shell]).stdout.toString();
const bashScript = script("bash");

/** What bash offers for `line` with the cursor at its end (a trailing space starts a new word). */
function bash(line: string): string[] {
  const words = line.split(" ");
  const p = Bun.spawnSync(
    [
      "bash",
      "--norc",
      "-c",
      'source /dev/stdin; COMP_WORDS=("$@"); COMP_CWORD=$(($# - 1)); _cctr; printf "%s\\n" "${COMPREPLY[@]}"',
      "x",
      ...words,
    ],
    {
      stdin: new TextEncoder().encode(bashScript),
    },
  );
  return p.stdout.toString().split("\n").filter(Boolean).sort();
}

describe("bash", () => {
  test("commands and subcommands, with or without global options before them", () => {
    expect(bash("cctr se")).toEqual(["sessions"]);
    expect(bash("cctr sessions l")).toEqual(["latest", "list"]);
    expect(bash("cctr --host all se")).toEqual(["sessions"]);
    expect(bash("cctr --host all sessions l")).toEqual(["latest", "list"]);
    expect(bash("cctr --format table sessions --host all l")).toEqual(["latest", "list"]);
  });

  test("options of the command at hand, global ones included, wherever they sit", () => {
    expect(bash("cctr sessions list --l")).toEqual(["--limit", "--local"]);
    expect(bash("cctr --host all sessions list --l")).toEqual(["--limit", "--local"]);
    expect(bash("cctr meta --ho")).toEqual(["--host"]);
    expect(bash("cctr --")).toEqual(["--format", "--help", "--host", "--version"]);
    // `list` under remote is not sessions list
    expect(bash("cctr remote list --l")).toEqual([]);
  });

  test("option values: choices where there are any, the shell's filenames otherwise", () => {
    expect(bash("cctr --format t")).toEqual(["table"]);
    expect(bash("cctr sessions list --cwd ")).toEqual([]);
    expect(bashScript).toContain("complete -o default -F _cctr cctr");
  });
});

describe("zsh", () => {
  const z = script("zsh");

  test("parses, and the root _arguments knows the global options", () => {
    expect(Bun.spawnSync(["zsh", "-n"], { stdin: new TextEncoder().encode(z) }).exitCode).toBe(0);
    const root = z.slice(z.indexOf("_arguments -C"), z.indexOf("'1: :->cmd'"));
    expect(root).toContain("'--host[");
    expect(root).toContain("'--format[output format]:value:(json table id)'");
  });
});

describe("fish", () => {
  const f = script("fish");

  test("global options are offered everywhere; a subcommand's options only under its parent", () => {
    expect(f).toContain("complete -c cctr -l host -d");
    expect(f).toMatch(/\(__cctr_pos\)\[1\] = remote; and test \(__cctr_pos\)\[2\] = add' -l url/);
    expect(f).toMatch(/\(__cctr_pos\)\[1\] = sessions; and test \(__cctr_pos\)\[2\] = list' -l limit/);
    expect(f).not.toMatch(/\(__cctr_pos\)\[1\] = remote; and test \(__cctr_pos\)\[2\] = list' -l limit/);
  });
});

test("an unknown shell is exit 2", () => {
  expect(Bun.spawnSync(["bun", CLI, "completion", "pwsh"]).exitCode).toBe(2);
});
