import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LocalSource, listSessionFiles, resolveSessionFile, sidOf, toMeta, toWire } from "../src";

const FIX = join(import.meta.dir, "fixtures", "2.1.267");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

describe("sidOf", () => {
  test("is the first 6 chars of base32(sha1(id)), the definition cc-sid uses", () => {
    expect(sidOf(A)).toBe("EOMGKY");
    expect(sidOf(B)).toBe("OZIFHC");
  });
});

describe("sid on records and lookup", () => {
  const src = new LocalSource({ projectsDir: FIX, host: "fixture" });

  test("getSession and listSessions carry the sid", async () => {
    expect((await src.getSession(A))!.sid).toBe("EOMGKY");
    const all = await src.listSessions();
    expect(Object.fromEntries(all.map((m) => [m.id, m.sid]))).toEqual({ [A]: "EOMGKY", [B]: "OZIFHC" });
  });

  test("a sid resolves to its session the way a prefix does", async () => {
    expect((await src.getSession("OZIFHC"))!.id).toBe(B);
    expect(resolveSessionFile("EOMGKY", listSessionFiles(FIX))!.file).toContain(A);
  });

  test("an unknown sid and a lowercased sid resolve to nothing", async () => {
    expect(await src.getSession("ZZZZZZ")).toBeNull();
    expect(await src.getSession("eomgky")).toBeNull();
  });

  test("the wire form has no sid; the receiving side recomputes it", async () => {
    const m = (await src.getSession(A))!;
    expect(toMeta(toWire(m), "h").sid).toBe("EOMGKY");
  });
});
