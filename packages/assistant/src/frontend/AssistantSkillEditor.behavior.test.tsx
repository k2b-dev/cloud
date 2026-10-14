import { expect, spyOn, test } from "bun:test";
import type { AiSkill } from "@k2b/cloud/ai";
import { createDomTestHarness } from "../../../ui/test/dom";
import { assistantApi } from "../api/client";

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

test("an imported Skill lists skipped files and saves the manual-only switch next to its other frontmatter", async () => {
  const dom = createDomTestHarness();
  dom.root.className = "k2b-ui";
  const { render } = await import("solid-js/web");
  const { toast } = await import("@k2b/ui");
  const { AssistantSkillEditor } = await import("./AssistantSkillsSettings");
  const createSkill = spyOn(assistantApi, "createSkill").mockImplementation(
    async (input): Promise<AiSkill> => ({
      ...input,
      extraFrontmatter: input.extraFrontmatter ?? {},
      references: input.references ?? [],
      source: null,
      id: "skill1",
      shortId: "skill1",
      permission: "admin",
      enabled: true,
      manualOnly: true,
      revision: 1,
      referenceCount: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
  );
  const saved = spyOn(toast, "success").mockReturnValue({ dismiss() {}, update() {} });
  const dispose = render(
    () => (
      <AssistantSkillEditor
        request={{
          imported: {
            name: "monthly-close",
            description: "Close the month from receipts.",
            instructions: "Reconcile every receipt.",
            extraFrontmatter: { license: "MIT" },
            references: [],
            skipped: ["LICENSE.txt", "scripts/"],
          },
        }}
        onBack={() => {}}
        onClose={() => {}}
      />
    ),
    dom.root,
  );
  try {
    await tick();
    expect(dom.root.textContent).toContain("Some files are not imported");
    expect(dom.root.textContent).toContain(
      "LICENSE.txt, scripts/. Cloud keeps SKILL.md and Markdown files directly in references/ with lowercase names",
    );
    const manualOnly = dom.document.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(manualOnly.checked).toBe(false);
    manualOnly.click();
    await tick();
    Array.from(dom.document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Create skill")!
      .click();
    await tick();
    expect(createSkill.mock.calls[0]?.[0].extraFrontmatter).toEqual({ license: "MIT", "disable-model-invocation": true });
  } finally {
    dispose();
    createSkill.mockRestore();
    saved.mockRestore();
    dom.cleanup();
  }
});
