import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { validateAiSkillDescription, validateAiSkillInstructions, validateAiSkillReferences } from "./skill-format";
import { getBuiltinAiSkillTemplate, seedCloudAiSkills } from "./skill-seeds";
import { aiSkills } from "./skills";

afterEach(() => mock.restore());

describe("Cloud AI Skill seeds", () => {
  test("seeds task-oriented Skills with on-demand references once", async () => {
    const seedOnce = spyOn(aiSkills, "seedOnce").mockResolvedValue();

    await seedCloudAiSkills();

    expect(seedOnce).toHaveBeenCalledTimes(9);
    const inputs = seedOnce.mock.calls.map(([input]) => input);
    const kit = inputs.find((candidate) => candidate.name === "cloud-kit");
    expect(kit?.instructions).toContain("search_help");
    expect(kit?.instructions).toContain("read_help");
    expect(kit?.instructions).toContain("kit.source.apply");
    expect(kit?.instructions).not.toContain("kit.sdk.read");
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

    const assistant = inputs.find((candidate) => candidate.name === "cloud-assistant");
    expect(assistant).toMatchObject({ key: "assistant:cloud-assistant", name: "cloud-assistant" });
    for (const text of [
      "runtime Chat ID",
      "core.ai.chat.search",
      "core.ai.chat.message",
      "exact runtime timezone",
      "Project and permissions",
    ]) {
      expect(assistant?.instructions).toContain(text);
    }
    const coreSource = await Bun.file(new URL("../../../core/src/capabilities.ts", import.meta.url)).text();
    const declaredCoreCapabilities = new Set([...coreSource.matchAll(/^    "([a-z0-9.-]+)": \{/gm)].map((match) => `core.${match[1]!}`));
    for (const match of assistant?.instructions.matchAll(/`(core\.[a-z0-9.-]+)`/g) ?? []) {
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

  test("Grids skill uses canonical Help and names only declared capabilities", async () => {
    const grids = getBuiltinAiSkillTemplate("cloud-grids")!;
    expect(grids.instructions).toContain("Help is the product handbook");
    expect(grids.instructions).toContain("search_help");
    expect(grids.instructions).toContain("read_help");
    expect(grids.instructions).toContain("What is a custom app?");
    expect(grids.instructions).toContain("cannot change records");
    expect(grids.instructions).toContain("Before discovery, establish");
    expect(grids.instructions).toContain("preserving the requested entities");
    expect(grids.instructions).toContain("includeWriteContext true");
    expect(grids.instructions).toContain("TODAY()");
    const sources = await Promise.all(
      ["capabilities.ts", "daily-capabilities.ts"].map((path) => Bun.file(new URL(`../../../grids/src/${path}`, import.meta.url)).text()),
    );
    const declared = new Set(sources.flatMap((source) => [...source.matchAll(/"([a-z0-9.-]+)": \{/g)].map((match) => `grids.${match[1]}`)));
    for (const match of grids.instructions.matchAll(/`(grids\.[a-z0-9.-]+)`/g)) expect(declared.has(match[1]!)).toBeTrue();
    const help = await Bun.file(new URL("../../../grids/src/help/documents/en/grids-gql.help.md", import.meta.url)).text();
    expect(help).toContain("Query with AI");
  });
});
