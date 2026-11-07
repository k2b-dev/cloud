import { expect, test } from "bun:test";
import { aiSkillLoadTools, mountAiSkillInstructionLinks } from "@k2b/cloud/ai";
import { SKILLS } from "./skills";

test("ships its Skills with every reference linked from the instructions", () => {
  expect(SKILLS.map((skill) => skill.name)).toEqual([
    "code-authoring",
    "assistant-code-mode",
    "assistant-data-analysis",
    "cloud-assistant",
    "skill-creator",
  ]);
  for (const skill of SKILLS) for (const reference of skill.references) expect(skill.instructions).toContain(`](${reference.path})`);
});

test("Skills load only Core capabilities that exist", async () => {
  const coreSource = await Bun.file(new URL("../../core/src/capabilities.ts", import.meta.url)).text();
  const declared = new Set([...coreSource.matchAll(/^    "([a-z0-9.-]+)": \{/gm)].map((match) => `core.${match[1]!}`));
  const loaded = Object.fromEntries(SKILLS.map((skill) => [skill.name, aiSkillLoadTools(skill.extraFrontmatter)]));
  expect(loaded["assistant-code-mode"]).toEqual(["code_run"]);
  expect(loaded["code-authoring"]).toEqual([
    "code_init",
    "code_pull",
    "code_sdk",
    "code_write",
    "code_check",
    "code_test",
    "code_simulate",
    "code_submit",
    "code_diff",
  ]);
  expect(loaded["assistant-data-analysis"]).toEqual([]);
  for (const name of ["cloud-assistant", "skill-creator"]) expect(loaded[name]!.length).toBeGreaterThan(0);
  for (const name of Object.values(loaded)
    .flat()
    .filter((name) => name.startsWith("core.")))
    expect(declared).toContain(name);
});

test("code mode mounts its links when loaded and retains its Cloud type reference", () => {
  const ASSISTANT_CODE_MODE_SKILL = SKILLS.find((skill) => skill.name === "assistant-code-mode")!;
  const contract = ASSISTANT_CODE_MODE_SKILL.references.find((reference) => reference.path === "references/cloud.md");
  expect(contract).toBeDefined();
  expect(contract!.content.match(/```ts\n/g)).toHaveLength(1);
  expect(contract!.content.match(/```/g)).toHaveLength(2);
  expect(mountAiSkillInstructionLinks(ASSISTANT_CODE_MODE_SKILL.name, ASSISTANT_CODE_MODE_SKILL.instructions)).toContain(
    "](/skills/assistant-code-mode/references/cloud.md)",
  );
});
