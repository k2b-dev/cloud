import { expect, test } from "bun:test";
import { diffSkillVersions } from "./skill-diff";

test("lists only changed Skill files, SKILL.md first, with line counts", () => {
  const current = {
    markdown: "---\nname: a\n---\n\nOne\nTwo\n",
    references: [
      { path: "references/same.md", content: "Same\n" },
      { path: "references/old.md", content: "Old\n" },
    ],
  };
  const app = {
    markdown: "---\nname: a\n---\n\nOne\nThree\n",
    references: [
      { path: "references/same.md", content: "Same\n" },
      { path: "references/new.md", content: "New\n" },
    ],
  };
  const diff = diffSkillVersions(current, app);
  expect(diff.map((file) => file.path)).toEqual(["SKILL.md", "references/new.md", "references/old.md"]);
  expect(diff[0]).toMatchObject({ added: 1, removed: 1 });
  expect(diff[0]!.rows.filter((row) => row.kind === "added" || row.kind === "removed")).toEqual([
    { kind: "removed", value: "Two" },
    { kind: "added", value: "Three" },
  ]);
  expect(diff[1]).toMatchObject({ added: 1, removed: 0 });
  expect(diff[2]).toMatchObject({ added: 0, removed: 1 });
});

test("is empty when both versions match", () => {
  const version = { markdown: "---\nname: a\n---\n\nBody\n", references: [] };
  expect(diffSkillVersions(version, version)).toEqual([]);
});

test("collapses long unchanged runs to three lines of context around each change", () => {
  const body = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`);
  const changed = body.map((line, index) => (index === 10 ? "Changed" : line));
  const [file] = diffSkillVersions(
    { markdown: `${body.join("\n")}\n`, references: [] },
    { markdown: `${changed.join("\n")}\n`, references: [] },
  );
  expect(file!.rows).toEqual([
    { kind: "gap", count: 7 },
    { kind: "unchanged", value: "Line 8" },
    { kind: "unchanged", value: "Line 9" },
    { kind: "unchanged", value: "Line 10" },
    { kind: "removed", value: "Line 11" },
    { kind: "added", value: "Changed" },
    { kind: "unchanged", value: "Line 12" },
    { kind: "unchanged", value: "Line 13" },
    { kind: "unchanged", value: "Line 14" },
    { kind: "gap", count: 6 },
  ]);
});

test("shows a large rewrite as a replaced file instead of blocking the page", () => {
  const started = performance.now();
  const [skill, reference] = diffSkillVersions(
    { markdown: "---\nname: a\n---\n\nOld\n", references: [{ path: "references/big.md", content: "a\n".repeat(49_000) }] },
    { markdown: "---\nname: a\n---\n\nNew\n", references: [{ path: "references/big.md", content: "b\n".repeat(49_000) }] },
  );
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(skill).toMatchObject({ path: "SKILL.md", added: 1, removed: 1, replaced: false });
  expect(reference).toEqual({ path: "references/big.md", rows: [], added: 49_000, removed: 49_000, replaced: true });
});
