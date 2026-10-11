import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshSource, type SessionHits } from "@cctr/core";

const FIX = join(import.meta.dir, "..", "..", "..", "packages", "core", "test", "fixtures", "2.1.267");
const CLI = join(import.meta.dir, "..", "src", "index.ts");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const tmp = mkdtempSync(join(tmpdir(), "cctr-search-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const env = {
  ...process.env,
  CCTR_PROJECTS_DIR: FIX,
  CCTR_CONFIG_DIR: join(tmp, "config"),
  CCTR_STATE_DIR: join(tmp, "state"),
};

function cctr(args: string[]) {
  const p = Bun.spawnSync(["bun", CLI, ...args], { env });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("cctr search", () => {
  test("json: one object per hit with host, id, ts, role, kind, uuid, excerpt", () => {
    const r = cctr(["search", "files"]);
    expect(r.code).toBe(0);
    const hits = JSON.parse(r.out) as {
      host: string;
      id: string;
      ts: string;
      role: string;
      kind: string;
      excerpt: string;
    }[];
    expect(hits.map((h) => [h.host, h.id, h.role, h.kind, h.excerpt])).toEqual([
      ["local", A, "user", "text", "list the files"],
      ["local", A, "assistant", "text", "two files"],
    ]);
  });

  test("--limit caps hits in the flat form", () => {
    expect(JSON.parse(cctr(["search", "files", "--limit", "1"]).out)).toHaveLength(1);
  });

  test("--group: one object per session with total and capped hits", () => {
    const r = cctr(["search", "files", "--group", "--hits-per", "1"]);
    const g = JSON.parse(r.out) as { id: string; total: number; hits: unknown[]; cwd: string }[];
    expect(g.map((s) => [s.id, s.total, s.hits.length, s.cwd])).toEqual([[A, 2, 1, "/home/u/proj-a"]]);
  });

  test("-l: sessions only; --format id prints host-qualified ids", () => {
    const r = cctr(["search", "h", "-l"]);
    const l = JSON.parse(r.out) as { id: string; hits?: unknown }[];
    expect(l.map((s) => s.id).sort()).toEqual([A, B]);
    expect(l.every((s) => s.hits === undefined)).toBe(true);
    const ids = cctr(["--format", "id", "search", "hello", "-l"]);
    expect(ids.out.trim()).toBe(`local:${B}`);
  });

  test("no hit is exit 3 with an empty result; a bad regex is exit 2", () => {
    const none = cctr(["search", "no-such-text-anywhere"]);
    expect(none.code).toBe(3);
    expect(JSON.parse(none.out)).toEqual([]);
    expect(cctr(["search", "(", "--regex"]).code).toBe(2);
  });

  test("--role, --session and table output", () => {
    expect((JSON.parse(cctr(["search", "files", "--role", "user"]).out) as unknown[]).length).toBe(1);
    expect(cctr(["search", "files", "--role", "bot"]).code).toBe(2);
    expect(JSON.parse(cctr(["search", "h", "--session", "bbbb"]).out).every((h: { id: string }) => h.id === B)).toBe(
      true,
    );
    const t = cctr(["--format", "table", "search", "files"]);
    expect(t.code).toBe(0);
    expect(t.out).toContain("list the files");
  });

  test("--format ndjson: one SessionHits per line, the shape the SSH path reads", () => {
    const r = cctr(["--format", "ndjson", "search", "files"]);
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SessionHits);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.session.id).toBe(A);
    expect(lines[0]!.total).toBe(2);
  });
});

describe("SshSource.search", () => {
  test("runs the remote cctr's search and reads its ndjson", async () => {
    // a fake ssh that runs the remote command line locally, and a `cctr` that is this CLI
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const ssh = join(bin, "fake-ssh");
    writeFileSync(ssh, '#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n');
    const remote = join(bin, "cctr-remote");
    writeFileSync(
      remote,
      `#!/bin/sh\nCCTR_PROJECTS_DIR='${FIX}' CCTR_CONFIG_DIR='${join(tmp, "config")}' exec bun '${CLI}' "$@"\n`,
    );
    chmodSync(ssh, 0o755);
    chmodSync(remote, 0o755);
    const src = new SshSource({ host: "sshbox", target: "someone@box", sshCommand: ssh, command: remote });
    const out: SessionHits[] = [];
    for await (const s of src.search({ query: "two files", role: "assistant" })) out.push(s);
    expect(out.map((s) => [s.session.host, s.session.id, s.total, s.hits[0]!.excerpt])).toEqual([
      ["sshbox", A, 1, "two files"],
    ]);
  });
});
