import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = join(import.meta.dir, "..", "..", "..", "packages", "core", "test", "fixtures", "2.1.267");
const CLI = join(import.meta.dir, "..", "src", "index.ts");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const tmp = mkdtempSync(join(tmpdir(), "cctr-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function cctr(args: string[], projects = FIX) {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    env: {
      ...process.env,
      CCTR_PROJECTS_DIR: projects,
      CCTR_CONFIG_DIR: join(tmp, "config"),
      CCTR_STATE_DIR: join(tmp, "state"),
    },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("sessions get <sid>", () => {
  test("a 6-char sid resolves to its session", () => {
    const r = cctr(["sessions", "get", "EOMGKY"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).id).toBe(A);
    expect(JSON.parse(r.out).sid).toBe("EOMGKY");
  });

  test("an unknown sid says no session hashes to it, with exit 3", () => {
    const r = cctr(["sessions", "get", "ZZZZZZ"]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/no session hashes to sid ZZZZZZ/);
    expect(r.err).toMatch(/local/);
  });

  test("a lowercased sid is not a sid: the plain not-found message", () => {
    const r = cctr(["sessions", "get", "eomgky"]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/session not found: eomgky/);
  });

  test("records accepts a sid too", () => {
    const r = cctr(["sessions", "records", "EOMGKY"]);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n").length).toBeGreaterThan(3);
  });
});

describe("--fields", () => {
  test("json keeps only the named keys, in the named order", () => {
    const r = cctr(["sessions", "list", "--fields", "sid,id,cwd"]);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as object[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Object.keys(row)).toEqual(["sid", "id", "cwd"]);
    const a = rows.find((r) => (r as { id: string }).id === A);
    expect(a).toEqual({ sid: "EOMGKY", id: A, cwd: "/home/u/proj-a" });
  });

  test("an empty or repeated field list is a usage error", () => {
    expect(cctr(["sessions", "list", "--fields", ","]).code).toBe(2);
    const dup = cctr(["sessions", "list", "--fields", "id,id"]);
    expect(dup.code).toBe(2);
    expect(dup.err).toMatch(/duplicate field: id/);
  });

  test("latest --format table prints the named columns", () => {
    const r = cctr(["--format", "table", "sessions", "latest", "--fields", "sid,cwd"]);
    expect(r.code).toBe(0);
    // which fixture is latest depends on checkout mtimes, so either row is right
    const lines = r.out.trimEnd().split("\n");
    expect(lines.slice(0, 2)).toEqual(["sid     cwd", "------  --------------"]);
    expect(["EOMGKY  /home/u/proj-a", "OZIFHC  /home/u/proj-b"]).toContain(lines[2]!);
    expect(lines).toHaveLength(3);
  });

  test("latest honors it too", () => {
    const r = cctr(["sessions", "latest", "--format", "json", "--fields", "id,host"]);
    expect(r.code).toBe(0);
    expect(Object.keys(JSON.parse(r.out))).toEqual(["id", "host"]);
  });

  test("an unknown field is a usage error naming the known ones", () => {
    const r = cctr(["sessions", "list", "--fields", "id,nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown field: nope/);
    expect(r.err).toMatch(/lastPrompt/);
  });

  test("table prints the named columns in order and does not truncate them", () => {
    const longCwd = "/home/someone/.ccx/github.com/SomeOrg/some-long-repository-name/01ABCDEFGHJKMN";
    const dir = join(tmp, "projects", "-p");
    mkdirSync(dir, { recursive: true });
    const id = "cccccccc-0000-4000-8000-000000000003";
    writeFileSync(
      join(dir, `${id}.jsonl`),
      JSON.stringify({
        type: "user",
        sessionId: id,
        cwd: longCwd,
        timestamp: "2026-01-01T00:00:00Z",
        message: { role: "user", content: "hi" },
      }) +
        "\n" +
        JSON.stringify({
          type: "last-prompt",
          lastPrompt: "a last prompt that is well over forty-four characters long, kept whole",
        }) +
        "\n",
    );
    const r = cctr(["--format", "table", "sessions", "list", "--fields", "cwd,lastPrompt"], join(tmp, "projects"));
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^cwd\s+lastPrompt$/);
    expect(lines[2]).toContain(longCwd);
    expect(lines[2]).toContain("kept whole");
    expect(r.out).not.toContain("…");
  });
});

describe("SshSource and sid", () => {
  test("a remote too old to send sid still gets one", async () => {
    const { chmodSync } = await import("node:fs");
    const { SshSource } = await import("@cctr/core");
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const ssh = join(bin, "fake-ssh");
    writeFileSync(ssh, '#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n');
    const old = join(bin, "old-cctr");
    writeFileSync(old, `#!/bin/sh\necho '[{"id":"${A}","host":"local"}]'\n`);
    chmodSync(ssh, 0o755);
    chmodSync(old, 0o755);
    const src = new SshSource({ host: "box", target: "u@box", sshCommand: ssh, command: old });
    const [m] = await src.listSessions();
    expect(m!.sid).toBe("EOMGKY");
    expect(m!.host).toBe("box");
  });
});
