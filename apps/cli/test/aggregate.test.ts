import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FetchLike, HttpSource, LocalSource, SshSource } from "@cctr/core";
import { createApp } from "@cctr/agent";

import { corpus } from "../../../packages/core/test/count.test";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const GOOD = "fixture-good-value";
const tmp = mkdtempSync(join(tmpdir(), "cctr-agg-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const projects = corpus();

function cctr(args: string[]) {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    env: {
      ...process.env,
      TZ: "Asia/Tokyo",
      CCTR_PROJECTS_DIR: projects,
      CCTR_CONFIG_DIR: join(tmp, "config"),
      CCTR_STATE_DIR: join(tmp, "state"),
    },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const j = (args: string[]) => JSON.parse(cctr(args).out);

describe("session-level aggregates (from SessionMeta)", () => {
  test("tokens: totals and session count", () => {
    expect(j(["tokens"])).toEqual({ sessions: 2, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  });

  test("stats --by repo|day|model|session groups sessions; unknown --by is exit 2", () => {
    const repo = j(["stats", "--by", "repo"]) as { key: string; sessions: number; turns: number; tools: number }[];
    expect(repo.map((g) => [g.key, g.sessions, g.turns, g.tools]).sort()).toEqual([
      ["/w/a", 1, 1, 7],
      ["/w/b", 1, 1, 2],
    ]);
    expect((j(["stats", "--by", "day"]) as { key: string }[]).map((g) => g.key).sort()).toEqual([
      "2026-08-01",
      "2026-09-01",
    ]);
    expect((j(["stats"]) as unknown[]).length).toBe(2);
    expect(cctr(["stats", "--by", "week"]).code).toBe(2);
  });

  test("tools: per-tool counts; --expand-skills splits Skill by skill name", () => {
    expect(j(["tools"])).toEqual({ Bash: 3, Skill: 3, Edit: 1, Write: 1, NotebookEdit: 1 });
    expect(j(["tools", "--expand-skills"])).toEqual({
      Bash: 3,
      "Skill:tdd": 2,
      "Skill:?": 1,
      Edit: 1,
      Write: 1,
      NotebookEdit: 1,
    });
  });
});

describe("record-level aggregates (Count)", () => {
  test("bash --top / --full", () => {
    expect(j(["bash"])).toEqual({ git: 2, ls: 1 });
    expect(j(["bash", "--top", "1"])).toEqual({ git: 2 });
    expect(Object.keys(j(["bash", "--full"]))).toContain("git log");
  });

  test("files", () => {
    expect(j(["files"])).toEqual({ "/w/a/x.ts": 2, "/w/a/n.ipynb": 1 });
  });

  test("commands --source slash|tool|all", () => {
    expect(j(["commands", "--source", "slash"])).toEqual({ review: 1, clear: 1 });
    expect(j(["commands", "--source", "tool"])).toEqual({ tdd: 2 });
    expect(j(["commands"])).toEqual({ tdd: 2, review: 1, clear: 1 });
    expect(cctr(["commands", "--source", "x"]).code).toBe(2);
  });

  test("activity: totals and a 24-slot local-time histogram (TZ=Asia/Tokyo here)", () => {
    const a = j(["activity"]) as { sessions: number; records: number; activeMs: number; byHour: number[] };
    expect(a.sessions).toBe(2);
    expect(a.records).toBe(11);
    expect(a.activeMs).toBe(94 * 60_000);
    expect(a.byHour).toHaveLength(24);
    // 09 and 10 UTC are 18 and 19 JST; 23 UTC is 08 JST
    expect([a.byHour[18], a.byHour[19], a.byHour[8]]).toEqual([3, 5, 3]);
    expect(a.byHour.reduce((s, n) => s + n, 0)).toBe(11);
    const t = cctr(["--format", "table", "activity"]);
    expect(t.out).toContain("hour-of-day (local time)");
  });

  test("--cwd narrows a count", () => {
    expect(j(["bash", "--cwd", "/w/b"])).toEqual({ ls: 1 });
  });
});

describe("Count over HTTP and SSH", () => {
  test("HttpSource.count round-trips through the agent", async () => {
    const app = createApp({ source: new LocalSource({ projectsDir: projects }), token: GOOD });
    const fetchApp: FetchLike = async (i, init) => app.fetch(new Request(i, init));
    const src = new HttpSource({ host: "h", url: "http://x", token: GOOD, fetch: fetchApp });
    const r = await src.count({ kind: "hour", cwd: "/w/a" });
    expect(r).toEqual({
      sessions: 1,
      records: 8,
      activeMs: 54 * 60_000,
      counts: { "2026-09-01T09": 3, "2026-09-01T10": 5 },
    });
    // 3 is Connect's InvalidArgument; this package does not depend on @connectrpc/connect
    await expect(src.count({ kind: "nope" as "bash" })).rejects.toMatchObject({ code: 3 });
  });

  test("SshSource.count runs the remote cctr", async () => {
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const ssh = join(bin, "fake-ssh");
    writeFileSync(ssh, '#!/bin/sh\nfor a; do last="$a"; done\nexec sh -c "$last"\n');
    const remote = join(bin, "cctr-remote");
    writeFileSync(
      remote,
      `#!/bin/sh\nCCTR_PROJECTS_DIR='${projects}' CCTR_CONFIG_DIR='${join(tmp, "config")}' exec bun '${CLI}' "$@"\n`,
    );
    chmodSync(ssh, 0o755);
    chmodSync(remote, 0o755);
    const src = new SshSource({ host: "box", target: "u@box", sshCommand: ssh, command: remote });
    expect((await src.count({ kind: "files" })).counts).toEqual({ "/w/a/x.ts": 2, "/w/a/n.ipynb": 1 });
  });
});
