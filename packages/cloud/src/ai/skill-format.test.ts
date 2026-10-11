import { describe, expect, test } from "bun:test";
import {
  isAiSkillManualOnly,
  mountAiSkillInstructionLinks,
  parseAiSkillMarkdown,
  serializeAiSkillMarkdown,
  validateAiSkillExtraFrontmatter,
  validateAiSkillReferences,
} from "./skill-format";

describe("Agent Skill format", () => {
  test("round-trips required and optional SKILL.md frontmatter", () => {
    const source = `---
name: weekly-status
description: Summarize recent work into a concise weekly update.
license: MIT
metadata:
  author: Cloud
disable-model-invocation: true
vendor-extension:
  nested: [one, 2, false]
---

# Weekly status

List wins, blockers, and next steps.
`;
    const parsed = parseAiSkillMarkdown(source);
    expect(parsed).toEqual({
      name: "weekly-status",
      description: "Summarize recent work into a concise weekly update.",
      instructions: "# Weekly status\n\nList wins, blockers, and next steps.",
      extraFrontmatter: {
        license: "MIT",
        metadata: { author: "Cloud" },
        "disable-model-invocation": true,
        "vendor-extension": { nested: ["one", 2, false] },
      },
    });
    expect(parseAiSkillMarkdown(serializeAiSkillMarkdown(parsed))).toEqual(parsed);
  });

  test("rejects invalid names, missing bodies, and oversized instruction files", () => {
    expect(() => parseAiSkillMarkdown(`---\nname: Weekly Status\ndescription: Useful.\n---\n\nDo it.\n`)).toThrow("lowercase");
    expect(() => parseAiSkillMarkdown(`---\nname: weekly-status\ndescription: Useful.\n---\n\n`)).toThrow("instructions are required");
    expect(() =>
      parseAiSkillMarkdown(
        `---\nname: weekly-status\ndescription: Useful.\n---\n\n${Array.from({ length: 501 }, () => "line").join("\n")}`,
      ),
    ).toThrow("500 instruction lines");
  });

  test("keeps references flat, Markdown-only, unique, and bounded", () => {
    expect(validateAiSkillReferences([{ path: "references/style-guide.md", content: "# Style" }])).toEqual([
      { path: "references/style-guide.md", content: "# Style" },
    ]);
    expect(() => validateAiSkillReferences([{ path: "../secret.md", content: "no" }])).toThrow("references/<name>.md");
    expect(() => validateAiSkillReferences([{ path: "references/nested/example.md", content: "no" }])).toThrow("references/<name>.md");
    expect(() =>
      validateAiSkillReferences([
        { path: "references/a.md", content: "a" },
        { path: "references/a.md", content: "b" },
      ]),
    ).toThrow("duplicated");
  });
});

test("manual-only requires the exact boolean frontmatter value", () => {
  expect(isAiSkillManualOnly({ "disable-model-invocation": true })).toBe(true);
  for (const value of [false, "true", 1, null, undefined]) expect(isAiSkillManualOnly({ "disable-model-invocation": value })).toBe(false);
});

test("extra frontmatter rejects collisions, non-JSON values, and oversized values", () => {
  for (const key of ["name", "description"])
    expect(() => validateAiSkillExtraFrontmatter({ [key]: "collision" })).toThrow("collide on export");
  for (const value of [undefined, Number.NaN, () => {}, 1n, new Map([["lost", "value"]]), new Date()])
    expect(() => validateAiSkillExtraFrontmatter({ custom: { value } })).toThrow("represented as JSON");
  expect(() => validateAiSkillExtraFrontmatter({ custom: "x".repeat(20_000) })).toThrow("20000 characters");
});

test("mounts flat relative Markdown reference links without changing other paths", () => {
  const instructions = "[A](references/a.md) [B](/skills/other/references/b.md) [C](references/nested/c.md) `references/a.md`";
  expect(mountAiSkillInstructionLinks("weekly-status", instructions)).toBe(
    "[A](/skills/weekly-status/references/a.md) [B](/skills/other/references/b.md) [C](references/nested/c.md) `references/a.md`",
  );
});
