import { expect, test } from "bun:test";
import { codeAdminDiffStat, codeAdminPermissionChanges } from "./admin";

test("list summaries count changed lines, whole first versions, and fall back to file counts when the budget is spent", () => {
  const before = { "a.ts": "one\ntwo\nthree", "same.ts": "x" };
  const after = { "a.ts": "one\nTWO\nthree\nfour", "same.ts": "x", "new.ts": "n" };
  expect(codeAdminDiffStat(before, after, performance.now() + 1000)).toEqual({ first: false, added: 3, removed: 1, lines: 6, files: 2 });
  expect(codeAdminDiffStat(null, after, performance.now() + 1000)).toEqual({ first: true, added: 6, removed: 0, lines: 6, files: 3 });
  expect(codeAdminDiffStat(before, after, performance.now() - 1)).toEqual({ first: false, added: null, removed: null, lines: 6, files: 2 });
});

test("permission changes deduplicate by operation and exact target and keep removed rows last", () => {
  const permission = (operation: string, id: string | null, line: number) => ({
    operation,
    target: id === null ? null : { type: "spaces.space", id },
    file: "code.ts",
    line,
  });
  expect(
    codeAdminPermissionChanges(
      [permission("spaces.task.list", "sp_1", 3), permission("spaces.task.create", "sp_2", 4), permission("spaces.task.create", "sp_2", 9)],
      [permission("spaces.task.list", "sp_1", 2), permission("spaces.task.create", "sp_1", 5), permission("spaces.app.read", null, 1)],
    ),
  ).toEqual([
    { ...permission("spaces.task.create", "sp_2", 4), change: "added" },
    { ...permission("spaces.task.list", "sp_1", 3), change: "same" },
    { ...permission("spaces.task.create", "sp_1", 5), change: "removed" },
    { ...permission("spaces.app.read", null, 1), change: "removed" },
  ]);
  expect(codeAdminPermissionChanges([permission("spaces.task.list", "sp_1", 3)], null)).toEqual([
    { ...permission("spaces.task.list", "sp_1", 3), change: "added" },
  ]);
});
