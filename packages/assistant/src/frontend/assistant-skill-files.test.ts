import { describe, expect, test } from "bun:test";
import { createZip } from "@k2b/stdlib/browser";
import { parseAiSkillArchive, readAiSkillImport } from "./assistant-skill-files";

const source = `---
name: weekly-status
description: Summarize recent work into a concise weekly update.
---

# Weekly status

List wins, blockers, and next steps.
`;

describe("Assistant Skill import", () => {
  test("imports a bare SKILL.md", async () => {
    const imported = await readAiSkillImport(new File([source], "SKILL.md", { type: "text/markdown" }));
    expect(imported).toMatchObject({
      name: "weekly-status",
      instructions: "# Weekly status\n\nList wins, blockers, and next steps.",
      references: [],
    });
  });

  test("imports a standard wrapped ZIP with Markdown references", async () => {
    const archive = await createZip([
      { filename: "weekly-status/SKILL.md", source },
      { filename: "weekly-status/references/style.md", source: "# Style\n\nBe concise." },
    ]);
    const imported = await parseAiSkillArchive(archive);
    expect(imported.references).toEqual([{ path: "references/style.md", content: "# Style\n\nBe concise." }]);
  });

  test("rejects executable or unknown archive files", async () => {
    const archive = await createZip([
      { filename: "weekly-status/SKILL.md", source },
      { filename: "weekly-status/scripts/run.ts", source: "throw new Error('no')" },
    ]);
    await expect(parseAiSkillArchive(archive)).rejects.toThrow("not scripts or assets");
  });
});
