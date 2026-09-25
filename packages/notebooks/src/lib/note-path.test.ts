import { describe, expect, test } from "bun:test";
import { buildNotePaths, NOTE_PATH_MAX_SEGMENTS, noteSlug, parseNotePath, resolveNotePath, siblingsWithTitle } from "./note-path";

const node = (id: string, title: string, parentId: string | null = null) => ({ id, shortId: id, parentId, title });

describe("noteSlug", () => {
  test("lowercases, transliterates German letters, and joins words with one dash", () => {
    expect(noteSlug("Backup und Restore")).toBe("backup-und-restore");
    expect(noteSlug("Übersicht: Größe & Maße")).toBe("uebersicht-groesse-masse");
    expect(noteSlug("ÄÖÜ äöü ß")).toBe("aeoeue-aeoeue-ss");
    expect(noteSlug("Café Crème")).toBe("cafe-creme");
    expect(noteSlug("  --Plan (v2)--  ")).toBe("plan-v2");
  });

  test("falls back to untitled and bounds the length", () => {
    expect(noteSlug("???")).toBe("untitled");
    expect(noteSlug("a".repeat(200))).toHaveLength(80);
    expect(noteSlug(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
  });

  test("is stable when applied to its own output", () => {
    for (const title of ["Backup und Restore", "Übersicht", "index", "a--b"]) expect(noteSlug(noteSlug(title))).toBe(noteSlug(title));
  });
});

describe("parseNotePath", () => {
  test("ignores empty segments and surrounding slashes", () => {
    expect(parseNotePath("/betrieb//backup/")).toEqual({ ok: true, segments: ["betrieb", "backup"] });
    expect(parseNotePath("")).toEqual({ ok: true, segments: [] });
  });

  test("bounds length and depth", () => {
    expect(parseNotePath("a/".repeat(NOTE_PATH_MAX_SEGMENTS + 1)).ok).toBe(false);
    expect(parseNotePath("a".repeat(2_001)).ok).toBe(false);
  });
});

describe("buildNotePaths", () => {
  const nodes = [
    node("root01", "Betrieb"),
    node("dup001", "Backup", "root01"),
    node("dup002", "backup!", "root01"),
    node("uniq01", "Größe", "root01"),
    node("index1", "Index", "root01"),
    node("child1", "Restore", "dup001"),
  ];

  test("address paths use title slugs and may repeat for duplicate titles", () => {
    const paths = buildNotePaths(nodes, { mirror: false });
    expect(paths.get("dup001")).toBe("betrieb/backup");
    expect(paths.get("dup002")).toBe("betrieb/backup");
    expect(paths.get("index1")).toBe("betrieb/index");
    expect(paths.get("child1")).toBe("betrieb/backup/restore");
  });

  test("mirror paths disambiguate shared slugs and the reserved index with the ID", () => {
    const paths = buildNotePaths(nodes, { mirror: true });
    expect(paths.get("dup001")).toBe("betrieb/backup--dup001");
    expect(paths.get("dup002")).toBe("betrieb/backup--dup002");
    expect(paths.get("uniq01")).toBe("betrieb/groesse");
    expect(paths.get("index1")).toBe("betrieb/index--index1");
    expect(paths.get("child1")).toBe("betrieb/backup--dup001/restore");
    expect(new Set(paths.values()).size).toBe(nodes.length);
  });
});

describe("resolveNotePath", () => {
  const betrieb = node("root01", "Betrieb");
  const backupA = node("dup001", "Backup", "root01");
  const backupB = node("dup002", "backup", "root01");
  const overview = node("sub001", "Übersicht", "root01");
  const nodes = [betrieb, backupA, backupB, overview];

  test("matches segments by slug, so titles and slugs both work", () => {
    expect(resolveNotePath(nodes, ["betrieb", "uebersicht"])).toEqual({ kind: "found", node: overview });
    expect(resolveNotePath(nodes, ["Betrieb", "Übersicht"])).toEqual({ kind: "found", node: overview });
  });

  test("reports the missing segment and the deepest parent", () => {
    expect(resolveNotePath(nodes, ["betrieb", "neu", "x"])).toEqual({ kind: "missing", parent: betrieb, index: 1 });
  });

  test("never guesses between siblings with the same slug and never parses an ID suffix", () => {
    expect(resolveNotePath(nodes, ["betrieb", "backup"])).toEqual({ kind: "ambiguous", index: 1, candidates: [backupA, backupB] });
    expect(resolveNotePath(nodes, ["betrieb", "backup--dup001"]).kind).toBe("missing");
  });

  test("resolves relative to a start note", () => {
    expect(resolveNotePath(nodes, ["uebersicht"], "root01")).toEqual({ kind: "found", node: overview });
    expect(resolveNotePath(nodes, [], "root01")).toEqual({ kind: "found", node: betrieb });
  });

  test("finds existing siblings with the same title slug", () => {
    expect(siblingsWithTitle(nodes, "root01", "BACKUP")).toEqual([backupA, backupB]);
    expect(siblingsWithTitle(nodes, null, "Betrieb")).toEqual([betrieb]);
  });
});
