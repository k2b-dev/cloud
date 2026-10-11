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
      skipped: [],
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

  test("imports a Skill below hidden directories and silently ignores relative hidden entries", async () => {
    const archive = await createZip([
      { filename: ".agents/skills/demo/SKILL.md", source },
      { filename: ".agents/skills/demo/references/style.md", source: "Be concise." },
      { filename: ".agents/skills/demo/.secret", source: "Secret" },
      { filename: ".agents/skills/demo/references/.hidden.md", source: "Hidden reference" },
      { filename: ".outside/file.txt", source: "Outside hidden" },
    ]);
    const imported = await parseAiSkillArchive(archive);
    expect(imported.references).toEqual([{ path: "references/style.md", content: "Be concise." }]);
    expect(imported.skipped).toEqual([]);
  });

  test("imports the repository cloud-cli folder shape and skips agent configuration", async () => {
    const archive = await createZip([
      { filename: "cloud-cli/SKILL.md", source: await Bun.file("skills/cloud-cli/SKILL.md").text() },
      { filename: "cloud-cli/references/commands.md", source: "Commands" },
      { filename: "cloud-cli/agents/openai.yaml", source: "interface: {}" },
    ]);
    const imported = await parseAiSkillArchive(archive);
    expect(imported.name).toBe("cloud-cli");
    expect(imported.references).toEqual([{ path: "references/commands.md", content: "Commands" }]);
    expect(imported.skipped).toEqual(["agents/"]);
  });

  test("skips unsupported entries, collapsing folders and sorting unique reports", async () => {
    const paths = [
      "scripts/run.ts",
      "scripts/nested/other.ts",
      "assets/logo.png",
      "LICENSE.txt",
      "references/API.md",
      "references/nested/a.md",
      "references/nested/b.md",
      "references/data.json",
      "evals/test.json",
    ];
    const archive = await createZip([
      { filename: "weekly-status/SKILL.md", source },
      { filename: "outside/file.txt", source: "Outside" },
      { filename: "__MACOSX/weekly-status/._SKILL.md", source: "Archiver noise" },
      { filename: "weekly-status/.DS_Store", source: "Archiver noise" },
      ...paths.map((path) => ({ filename: `weekly-status/${path}`, source: "Skipped" })),
    ]);
    const imported = await parseAiSkillArchive(archive);
    expect(imported.references).toEqual([]);
    expect(imported.skipped).toEqual([
      "LICENSE.txt",
      "assets/",
      "evals/",
      "outside/file.txt",
      "references/API.md",
      "references/data.json",
      "references/nested/",
      "scripts/",
    ]);
  });

  test.each(["../secret.md", "/absolute.md", "weekly-status/../secret.md", "C:/absolute.md"])(
    "rejects unsafe archive path %s",
    async (filename) => {
      const safeName = "x".repeat(filename.length);
      const archive = await createZip([
        { filename: "weekly-status/SKILL.md", source },
        { filename: safeName, source: "Unsafe" },
      ]);
      const buffer = Buffer.from(archive);
      const replacement = Buffer.from(filename);
      for (let offset = buffer.indexOf(safeName); offset >= 0; offset = buffer.indexOf(safeName, offset + replacement.length))
        replacement.copy(buffer, offset);
      await expect(parseAiSkillArchive(buffer)).rejects.toThrow("unsafe path");
    },
  );

  test("requires exactly one SKILL.md", async () => {
    for (const entries of [
      [],
      [
        { filename: "a/SKILL.md", source },
        { filename: "b/SKILL.md", source },
      ],
    ]) {
      await expect(parseAiSkillArchive(await createZip(entries))).rejects.toThrow("exactly one");
    }
  });
});
