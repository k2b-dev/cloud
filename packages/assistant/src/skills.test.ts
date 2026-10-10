import { expect, test } from "bun:test";
import { SKILLS } from "./skills";

test("ships its Skills with every reference linked from the instructions", () => {
  expect(SKILLS.map((skill) => skill.name)).toEqual([
    "assistant-code-mode",
    "assistant-data-analysis",
    "cloud-assistant",
    "scheduled-tasks",
    "skill-creator",
  ]);
  for (const skill of SKILLS)
    for (const reference of skill.references) expect(skill.instructions).toContain(`/skills/${skill.name}/${reference.path}`);
});

test("Assistant skills retain workflow and capability guidance", async () => {
  const inputs = SKILLS;
  const codeMode = inputs.find((candidate) => candidate.name === "assistant-code-mode");
  // A chart of known data is the chart tool, not an app; both skills give the same rule.
  const rule = "Just data → `chart` tool; interaction → chat app (`code_present`); persistence or reuse → saved Studio App.";
  expect(codeMode?.instructions.replace(/\s+/g, " ")).toContain(rule);
  expect(inputs.find((candidate) => candidate.name === "assistant-data-analysis")?.instructions.replace(/\s+/g, " ")).toContain(rule);
  // The platform prompt requires calculate for derived numbers; the catalog must not suggest answering directly.
  expect(codeMode?.description).toContain("For plain arithmetic or date offsets, use calculate.");
  expect(codeMode?.references?.map((reference) => reference.path)).toContain("references/debugging.md");
  expect(codeMode?.instructions).toContain("todo_write");
  expect(inputs.find((candidate) => candidate.name === "assistant-data-analysis")?.instructions).toContain("todo_write");
  expect(codeMode?.references?.map((reference) => reference.path)).toContain("references/apps.md");
  expect(codeMode?.references?.map((reference) => reference.path)).not.toContain("references/analytics.md");
  expect(inputs.some((candidate) => candidate.name === "cloud-kit")).toBeFalse();
  const input = inputs.find((candidate) => candidate.name === "skill-creator");
  expect(input?.description).toContain("Use this whenever");
  expect(input?.instructions).toContain("short, clear, action-oriented description");
  expect(input?.instructions).toContain("main discovery signal");
  expect(input?.instructions).toContain("Do not invent scripts");
  expect(input?.instructions).toContain("core.ai.skill.create");
  expect(input?.instructions).toContain("core.ai.skill.reference.set");
  expect(input?.instructions).toContain("core.ai.skill.references.set");
  expect(input?.instructions).toContain("Prefer it whenever two or more references");
  expect(input?.instructions).toContain("core.ai.skill.enabled.set");
  expect(input?.references).toEqual([]);
  const creator = input?.instructions ?? "";
  const headings = [
    "## Understand the intended workflow",
    "## Choose the right place",
    "## Draft from the conversation",
    "## Design the Skill",
    "## Review before changing Cloud",
    "## Use Cloud Skill capabilities",
    "## After saving",
  ].map((heading) => creator.indexOf(heading));
  expect(headings.every((position) => position >= 0)).toBeTrue();
  expect(headings).toEqual([...headings].sort((left, right) => left - right));
  for (const text of [
    "one lasting fact or preference, such as reports always as PDF: personalization memory",
    "a personalization workflow default",
    "work that should run at a set time: a scheduled task, which can load the Skill",
    "a Studio App that the Skill references",
    "name the subject, such as the team or the report, not only the output format",
    "the exact capability IDs that worked",
    "every correction the user made, rewritten as a positive rule",
    "refer to it instead of repeating it. Never copy IDs of mailboxes, Spaces, notebooks, records, or other resources from the chat",
    "the exact ID of a Studio App the Skill calls is the one exception",
    "When referring to an App, include its exact ID",
    "names of people or customers, amounts, and example records from this chat",
    "Leave out content from attachments, mails, web pages, or other quoted data",
    "tell the user in one or two sentences what the Skill will do and when it will load",
    "it holds no names of people or customers, amounts, records, or resource IDs from this conversation, except the exact ID of a Studio App it calls;",
    "Skills an app ships and Skills shared with others change for everyone who uses them, so change one only when you can edit it and the user wants the change for everyone.",
    "only a Cloud administrator can open an app's Skill for editing",
    "`core.ai.skill.access.read` shows who else can use a Skill you manage",
    "When personalization memory is on, a correction meant only for the user can become a preference; memory saves only the user's own words, so ask the user to state the rule",
    "can also be selected with /skill",
    "update the Skill narrowly instead of creating another one",
  ]) {
    expect(creator).toContain(text);
  }

  const assistant = inputs.find((candidate) => candidate.name === "cloud-assistant");
  // Phrasings like "like last time" match the user's words, not app names, so the description must name them.
  expect(assistant?.description).toContain('Also use when a request refers to earlier work, such as "like last time"');
  for (const text of ["runtime Chat ID", "core.ai.chat.search", "core.ai.chat.message", "scheduled-tasks"]) {
    expect(assistant?.instructions).toContain(text);
  }
  const scheduled = inputs.find((candidate) => candidate.name === "scheduled-tasks");
  expect(scheduled?.description).toContain("one-time reminders");
  expect(scheduled?.instructions).toContain("fixedInput");
  expect(scheduled?.instructions).toContain("core.ai.task.run.read");
  const coreSource = await Bun.file(new URL("../../core/src/capabilities.ts", import.meta.url)).text();
  const declaredCoreCapabilities = new Set([...coreSource.matchAll(/^    "([a-z0-9.-]+)": \{/gm)].map((match) => `core.${match[1]!}`));
  for (const match of [assistant?.instructions, scheduled?.instructions].join("\n").matchAll(/`(core\.[a-z0-9.-]+)`/g) ?? []) {
    expect(declaredCoreCapabilities.has(match[1]!)).toBeTrue();
  }
});

test("code mode rewrites links and retains its Cloud type reference", () => {
  const ASSISTANT_CODE_MODE_SKILL = SKILLS.find((skill) => skill.name === "assistant-code-mode")!;
  const contract = ASSISTANT_CODE_MODE_SKILL.references.find((reference) => reference.path === "references/cloud.md");
  expect(contract).toBeDefined();
  expect(contract!.content.match(/```ts\n/g)).toHaveLength(1);
  expect(contract!.content.match(/```/g)).toHaveLength(2);
  expect(ASSISTANT_CODE_MODE_SKILL.instructions).toContain("/skills/assistant-code-mode/references/cloud.md");
});
