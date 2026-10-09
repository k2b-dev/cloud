import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ASSISTANT_CODE_MODE_SKILL } from "./code-mode-skill";
import { ASSISTANT_DATA_ANALYSIS_SKILL } from "./data-analysis-skill";
import {
  validateAiSkillDescription,
  validateAiSkillExtraFrontmatter,
  validateAiSkillInstructions,
  validateAiSkillName,
  validateAiSkillReferences,
} from "./skill-format";
import { getBuiltinAiSkillTemplate } from "./skill-seeds";
import { type AiSkillTemplate, aiSkills, seedCloudAiSkills } from "./skills";

afterEach(() => mock.restore());

describe("Cloud AI Skill seeds", () => {
  test("seeds task-oriented Skills with on-demand references once", async () => {
    const seedOnce = spyOn(aiSkills, "seedOnce").mockResolvedValue();

    await seedCloudAiSkills();

    expect(seedOnce).toHaveBeenCalledTimes(11);
    const inputs = seedOnce.mock.calls.map(([input]) => input);
    const codeMode = inputs.find((candidate) => candidate.name === "assistant-code-mode");
    expect(codeMode).toMatchObject({ key: "assistant:code-mode", version: 63 });
    // The platform prompt requires calculate for derived numbers; the catalog must not suggest answering directly.
    expect(codeMode?.description).toContain("For plain arithmetic or date offsets, use calculate.");
    expect(codeMode?.references?.map((reference) => reference.path)).toContain("references/debugging.md");
    expect(inputs.find((candidate) => candidate.name === "assistant-data-analysis")).toMatchObject({
      key: "assistant:data-analysis",
      version: 8,
    });
    expect(codeMode?.instructions).toContain("todo_write");
    expect(inputs.find((candidate) => candidate.name === "assistant-data-analysis")?.instructions).toContain("todo_write");
    expect(codeMode?.references?.map((reference) => reference.path)).toContain("references/apps.md");
    expect(codeMode?.references?.map((reference) => reference.path)).not.toContain("references/analytics.md");
    expect(inputs.some((candidate) => candidate.name === "cloud-kit")).toBeFalse();
    const input = inputs.find((candidate) => candidate.name === "skill-creator");
    expect(input).toMatchObject({ key: "core:skill-creator", name: "skill-creator" });
    expect(input?.description).toContain("Use this whenever");
    expect(input?.instructions).toContain("short, clear, action-oriented description");
    expect(input?.instructions).toContain("main discovery signal");
    expect(input?.instructions).toContain("Do not invent scripts");
    expect(input?.instructions).toContain("core.ai.skill.create");
    expect(input?.instructions).toContain("core.ai.skill.reference.set");
    expect(input?.instructions).toContain("core.ai.skill.references.set");
    expect(input?.instructions).toContain("Prefer it whenever two or more references");
    expect(input?.instructions).toContain("core.ai.skill.enabled.set");
    expect(input?.references).toBeUndefined();
    expect(input?.version).toBe(3);
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
      "Built-in Skills and Skills shared with others change for everyone who uses them, so change one only when you can edit it and the user wants the change for everyone.",
      "`core.ai.skill.access.read` shows who else can use a Skill you manage",
      "When personalization memory is on, a correction meant only for the user can become a preference; memory saves only the user's own words, so ask the user to state the rule",
      "can also be selected with /skill",
      "update the Skill narrowly instead of creating another one",
    ]) {
      expect(creator).toContain(text);
    }

    const assistant = inputs.find((candidate) => candidate.name === "cloud-assistant");
    expect(assistant).toMatchObject({ key: "assistant:cloud-assistant", name: "cloud-assistant", version: 3 });
    // Phrasings like "like last time" match the user's words, not app names, so the description must name them.
    expect(assistant?.description).toContain('Also use when a request refers to earlier work, such as "like last time"');
    for (const text of ["runtime Chat ID", "core.ai.chat.search", "core.ai.chat.message", "scheduled-tasks"]) {
      expect(assistant?.instructions).toContain(text);
    }
    const scheduled = inputs.find((candidate) => candidate.name === "scheduled-tasks");
    expect(scheduled).toMatchObject({ key: "assistant:scheduled-tasks", version: 2 });
    expect(scheduled?.description).toContain("one-time reminders");
    expect(scheduled?.instructions).toContain("fixedInput");
    expect(scheduled?.instructions).toContain("core.ai.task.run.read");
    const coreSource = await Bun.file(new URL("../../../core/src/capabilities.ts", import.meta.url)).text();
    const declaredCoreCapabilities = new Set([...coreSource.matchAll(/^    "([a-z0-9.-]+)": \{/gm)].map((match) => `core.${match[1]!}`));
    for (const match of [assistant?.instructions, scheduled?.instructions].join("\n").matchAll(/`(core\.[a-z0-9.-]+)`/g) ?? []) {
      expect(declaredCoreCapabilities.has(match[1]!)).toBeTrue();
    }

    const mail = inputs.find((candidate) => candidate.name === "cloud-mail");
    expect(mail).toMatchObject({ key: "mail:cloud-mail", name: "cloud-mail" });
    expect(mail?.description).toContain("whenever a request involves Cloud Mail");
    expect(mail?.instructions).toContain("more specific loaded Skill overrides them");
    expect(mail?.instructions).toContain("mail.conversation.focus");
    expect(mail?.instructions).toContain("mail.draft.send.review");
    expect(mail?.instructions).toContain("let Mail derive reply recipients and threading");
    expect(mail?.instructions).toContain("Never introduce or sign as an AI or Cloud Assistant");
    expect(mail?.instructions).toContain("consider Contacts and its Skill rather than guessing an address");
    expect(mail?.instructions).toContain("consider Spaces and preserve a link to the mail conversation");
    expect(mail?.references).toBeUndefined();

    const mentionedCapabilities = [...(mail?.instructions.matchAll(/`(mail\.[a-z0-9.-]+)`/g) ?? [])].map((match) => match[1]!);
    const capabilitySource = await Bun.file(new URL("../../../mail/src/capabilities.ts", import.meta.url)).text();
    const declaredCapabilities = [...capabilitySource.matchAll(/^  (?:(?:"([a-z0-9.-]+)")|(search)): \{/gm)].map(
      (match) => `mail.${match[1] ?? match[2]}`,
    );
    for (const capability of mentionedCapabilities) expect(declaredCapabilities).toContain(capability);
    for (const capability of ["mail.mailbox.browse", "mail.message.read-content", "mail.draft.patch"]) {
      expect(mentionedCapabilities).toContain(capability);
    }

    const appSkills = [
      {
        name: "cloud-notebooks",
        key: "notebooks:cloud-notebooks",
        appId: "notebooks",
        source: "../../../notebooks/src/capabilities.ts",
        required: [
          "smallest structural",
          "content hash",
          "Never invent a `note://` target",
          "consider Spaces",
          ":::query",
          ":::toc",
          ":::data",
          "original saved note's hash",
          "ten minutes",
          "not a formula validator",
          "no required handbook fields",
        ],
      },
      {
        name: "cloud-contacts",
        key: "contacts:cloud-contacts",
        appId: "contacts",
        source: "../../../contacts/src/capabilities.ts",
        required: ["recipient suggestions", "Collection fields", "Do not invent an email address", "consider Spaces"],
      },
      {
        name: "cloud-spaces",
        key: "spaces:cloud-spaces",
        appId: "spaces",
        source: "../../../spaces/src/capabilities.ts",
        required: ["active blockers", "add the returned calendar attachment", "real prerequisites", "consider Contacts"],
      },
      {
        name: "cloud-weather",
        key: "weather:cloud-weather",
        appId: "weather",
        source: "../../../weather/src/capabilities.ts",
        required: ["unsaved German city", "only when the user asks", "time-sensitive estimates"],
      },
    ] as const;

    for (const expected of appSkills) {
      const skill = inputs.find((candidate) => candidate.name === expected.name);
      expect(skill).toMatchObject({ key: expected.key, name: expected.name });
      const instructions = [skill?.instructions, ...(skill?.references ?? []).map((reference) => reference.content)].join("\n");
      for (const text of expected.required) expect(instructions).toContain(text);

      const namedCapabilities = [...instructions.matchAll(new RegExp("`(" + expected.appId + "\\.[a-z0-9.-]+)`", "g"))].map(
        (match) => match[1]!,
      );
      const source = await Bun.file(new URL(expected.source, import.meta.url)).text();
      const declared = [...source.matchAll(/^    "([a-z0-9.-]+)": \{/gm)].map((match) => `${expected.appId}.${match[1]!}`);
      for (const capability of namedCapabilities) expect(declared).toContain(capability);
    }

    for (const skill of inputs) {
      expect(validateAiSkillDescription(skill.description)).toBe(skill.description);
      expect(validateAiSkillInstructions(skill.instructions)).toBe(skill.instructions);
      expect(validateAiSkillReferences(skill.references ?? [])).toEqual([...(skill.references ?? [])]);
      for (const reference of skill.references ?? []) {
        expect(skill.instructions).toContain(`/skills/${skill.name}/${reference.path}`);
      }
      if (["cloud-mail", "cloud-spaces", "cloud-notebooks"].includes(skill.name)) {
        expect(skill.instructions.length).toBeLessThan(5_000);
      }
    }

    const declaredAcrossApps = new Set(declaredCapabilities);
    for (const app of appSkills) {
      const source = await Bun.file(new URL(app.source, import.meta.url)).text();
      for (const match of source.matchAll(/^    "([a-z0-9.-]+)": \{/gm)) declaredAcrossApps.add(`${app.appId}.${match[1]}`);
    }
    for (const skill of inputs) {
      const content = [skill.instructions, ...(skill.references ?? []).map((reference) => reference.content)].join("\n");
      for (const match of content.matchAll(/`((?:mail|spaces|notebooks|contacts)\.[a-z0-9.-]+)`/g)) {
        expect(declaredAcrossApps.has(match[1]!)).toBeTrue();
      }
    }

    const spaces = inputs.find((skill) => skill.name === "cloud-spaces")!;
    for (const id of ["spaces.task.update", "spaces.event.update", "spaces.task.set-completed"]) {
      expect(spaces.instructions).toContain(id);
    }
    const calendar = spaces.references!.find((reference) => reference.path === "references/calendar-mail.md")!.content;
    expect(calendar).toContain("If the source is unavailable, stop");
    expect(calendar).toContain("UTF-8 bytes and then Base64");
    expect(calendar).toContain("mail.draft.create");

    expect(inputs.some((candidate) => candidate.name === "cloud-tools")).toBeFalse();
  });

  test("returns current templates without internal seed keys or reseeding", () => {
    const seed = spyOn(aiSkills, "seedOnce").mockResolvedValue();
    expect(getBuiltinAiSkillTemplate("unknown-skill")).toBeUndefined();
    const notebook = getBuiltinAiSkillTemplate("cloud-notebooks");
    expect(notebook).not.toHaveProperty("key");
    expect(notebook?.references?.map((reference) => reference.path)).toEqual(["references/structured-pages.md"]);
    expect(notebook?.instructions).toContain("notebooks.note.children");
    expect(notebook?.instructions).toContain("Never replace a complete note with a partial window");
    expect(getBuiltinAiSkillTemplate("cloud-spaces")?.instructions).toContain("spaces.event.agenda");
    expect(getBuiltinAiSkillTemplate("cloud-spaces")?.instructions).toContain("spaces.task.focus");
    expect(seed).not.toHaveBeenCalled();
  });

  test("Spaces seed upgrades instructions for incomplete assignee previews", async () => {
    const seed = spyOn(aiSkills, "seedOnce").mockResolvedValue();
    await seedCloudAiSkills();
    const spaces = seed.mock.calls.map(([input]) => input).find((input) => input.key === "spaces:cloud-spaces");
    expect(spaces?.version).toBe(2);
    expect(spaces?.instructions).toContain("at most three assignees and tags");
    expect(spaces?.instructions).toContain("relationsTruncated");
    expect(spaces?.instructions).toContain("assigneeCount");
    expect(spaces?.instructions).toContain("is larger than the number of `assignees`");
    expect(spaces?.instructions).toContain("3 of 11");
  });

  test("Weather seed upgrades instructions with the coordinates fallback", async () => {
    const seed = spyOn(aiSkills, "seedOnce").mockResolvedValue();
    await seedCloudAiSkills();
    const weather = seed.mock.calls.map(([input]) => input).find((input) => input.key === "weather:cloud-weather");
    expect(weather?.version).toBe(2);
    expect(weather?.instructions).toContain(
      'If city search is unavailable, use known coordinates with `weather.forecast.current` or `weather.forecast.get` and `source.kind = "coordinates"`',
    );
  });

  test("Grids skill uses canonical Help and names only declared capabilities", async () => {
    const grids = getBuiltinAiSkillTemplate("cloud-grids")!;
    expect(grids.version).toBe(7);
    expect(grids.instructions).toContain("Help is the product handbook");
    expect(grids.instructions).toContain("search_help");
    expect(grids.instructions).toContain("read_help");
    expect(grids.instructions).toContain("For product questions");
    expect(grids.instructions).toContain("cannot change records");
    expect(grids.instructions).toContain("Clarify vague goals before discovery");
    expect(grids.instructions).toContain("preserving the requested entities");
    expect(grids.instructions).toContain("includeWriteContext true");
    expect(grids.instructions).toContain("TODAY()");
    const sources = await Promise.all(
      ["capabilities.ts"].map((path) => Bun.file(new URL(`../../../grids/src/${path}`, import.meta.url)).text()),
    );
    const declared = new Set(sources.flatMap((source) => [...source.matchAll(/"([a-z0-9.-]+)": \{/g)].map((match) => `grids.${match[1]}`)));
    for (const match of grids.instructions.matchAll(/`(grids\.[a-z0-9.-]+)`/g)) expect(declared.has(match[1]!)).toBeTrue();
    const help = await Bun.file(new URL("../../../grids/src/help/documents/en/grids-gql.help.md", import.meta.url)).text();
    expect(help).toContain("Query with AI");
  });
});

test("generated Assistant skills pass every field validator used by seedOnce", () => {
  const skills: AiSkillTemplate[] = [ASSISTANT_CODE_MODE_SKILL, ASSISTANT_DATA_ANALYSIS_SKILL];
  for (const skill of skills) {
    expect(validateAiSkillName(skill.name)).toBe(skill.name);
    expect(validateAiSkillDescription(skill.description)).toBe(skill.description);
    expect(validateAiSkillInstructions(skill.instructions)).toBe(skill.instructions);
    expect(validateAiSkillExtraFrontmatter(skill.extraFrontmatter)).toEqual(skill.extraFrontmatter ?? {});
    const references = skill.references ?? [];
    expect(validateAiSkillReferences(references)).toEqual([...references]);
  }
  const contract = ASSISTANT_CODE_MODE_SKILL.references.find((reference) => reference.path === "references/cloud.md");
  expect(contract).toBeDefined();
  expect(contract!.content.match(/```ts\n/g)).toHaveLength(1);
  expect(contract!.content.match(/```/g)).toHaveLength(2);
  expect(ASSISTANT_CODE_MODE_SKILL.instructions).toContain("/skills/assistant-code-mode/references/cloud.md");
});
