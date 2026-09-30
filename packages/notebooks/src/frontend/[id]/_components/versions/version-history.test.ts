import { describe, expect, test } from "bun:test";
import { diffLines } from "diff";
import { buildDiffRows, orderComparison, summarizeDiff } from "./version-history";

describe("version history helpers", () => {
  test("numbers added, removed, and unchanged diff lines", () => {
    const rows = buildDiffRows([
      { value: "first\n" },
      { removed: true, value: "old\n" },
      { added: true, value: "new\nextra\n" },
      { value: "last\n" },
    ]);

    expect(rows).toEqual([
      { kind: "unchanged", value: "first", oldLine: 1, newLine: 1 },
      { kind: "removed", value: "old", oldLine: 2, newLine: null },
      { kind: "added", value: "new", oldLine: null, newLine: 2 },
      { kind: "added", value: "extra", oldLine: null, newLine: 3 },
      { kind: "unchanged", value: "last", oldLine: 3, newLine: 4 },
    ]);
    expect(summarizeDiff(rows)).toEqual({ added: 2, removed: 1, hasChanges: true });
  });

  test("turns the line diff of two note versions into numbered rows", () => {
    const rows = buildDiffRows(diffLines("# Title\n\nold line\nkept\n", "# Title\n\nnew line\nextra\nkept\nlast without newline"));

    expect(rows).toEqual([
      { kind: "unchanged", value: "# Title", oldLine: 1, newLine: 1 },
      { kind: "unchanged", value: "", oldLine: 2, newLine: 2 },
      { kind: "removed", value: "old line", oldLine: 3, newLine: null },
      { kind: "added", value: "new line", oldLine: null, newLine: 3 },
      { kind: "added", value: "extra", oldLine: null, newLine: 4 },
      { kind: "unchanged", value: "kept", oldLine: 4, newLine: 5 },
      { kind: "added", value: "last without newline", oldLine: null, newLine: 6 },
    ]);
    expect(summarizeDiff(rows)).toEqual({ added: 3, removed: 1, hasChanges: true });
    expect(summarizeDiff(buildDiffRows(diffLines("same\n", "same\n")))).toEqual({ added: 0, removed: 0, hasChanges: false });
    expect(buildDiffRows(diffLines("", ""))).toEqual([]);
  });

  test("keeps current as the newer comparison target", () => {
    expect(orderComparison("older", "__current__", [], "__current__")).toEqual({
      fromId: "older",
      toId: "__current__",
    });
  });

  test("orders two historical versions from older to newer", () => {
    const versions = [
      { id: "newer", createdAt: "2026-07-14T12:00:00.000Z" },
      { id: "older", createdAt: "2026-07-14T10:00:00.000Z" },
    ];

    expect(orderComparison("newer", "older", versions, "__current__")).toEqual({
      fromId: "older",
      toId: "newer",
    });
  });
});
