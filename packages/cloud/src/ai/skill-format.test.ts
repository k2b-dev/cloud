import { describe, expect, test } from "bun:test";
import {
  parseAiSkillMarkdown,
  serializeAiSkillMarkdown,
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
---

# Weekly status

List wins, blockers, and next steps.
`;
    const parsed = parseAiSkillMarkdown(source);
    expect(parsed).toEqual({
      name: "weekly-status",
      description: "Summarize recent work into a concise weekly update.",
      instructions: "# Weekly status\n\nList wins, blockers, and next steps.",
      extraFrontmatter: { license: "MIT", metadata: { author: "Cloud" } },
    });
    expect(parseAiSkillMarkdown(serializeAiSkillMarkdown(parsed))).toEqual(parsed);
  });

  test("rejects invalid names, unsupported metadata, missing bodies, and oversized instruction files", () => {
    expect(() =>
      parseAiSkillMarkdown(`---\nname: Weekly Status\ndescription: Useful.\n---\n\nDo it.\n`),
    ).toThrow("lowercase");
    expect(() =>
      parseAiSkillMarkdown(`---\nname: weekly-status\ndescription: Useful.\nsurprise: true\n---\n\nDo it.\n`),
    ).toThrow('Unsupported SKILL.md frontmatter field "surprise"');
    expect(() => parseAiSkillMarkdown(`---\nname: weekly-status\ndescription: Useful.\n---\n\n`)).toThrow(
      "instructions are required",
    );
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
    expect(() => validateAiSkillReferences([{ path: "references/nested/example.md", content: "no" }])).toThrow(
      "references/<name>.md",
    );
    expect(() =>
      validateAiSkillReferences([
        { path: "references/a.md", content: "a" },
        { path: "references/a.md", content: "b" },
      ]),
    ).toThrow("duplicated");
  });
});
