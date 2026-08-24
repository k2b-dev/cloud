import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { validateAiSkillDescription, validateAiSkillInstructions } from "./skill-format";
import { seedCloudAiSkills } from "./skill-seeds";
import { aiSkills } from "./skills";

afterEach(() => mock.restore());

describe("Cloud AI Skill seeds", () => {
  test("publishes ordinary single-file Skills once", async () => {
    const seedOnce = spyOn(aiSkills, "seedOnce").mockResolvedValue();

    await seedCloudAiSkills();

    expect(seedOnce).toHaveBeenCalledTimes(7);
    const inputs = seedOnce.mock.calls.map(([input]) => input);
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
    expect([...new Set(mentionedCapabilities)].sort()).toEqual(declaredCapabilities.sort());

    const appSkills = [
      {
        name: "cloud-notebooks",
        key: "notebooks:cloud-notebooks",
        appId: "notebooks",
        source: "../../../notebooks/src/capabilities.ts",
        required: ["smallest structural", "content hash", "Never invent a `note://` target", "consider Spaces"],
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
      expect(skill?.references).toBeUndefined();
      for (const text of expected.required) expect(skill?.instructions).toContain(text);

      const namedCapabilities = [...(skill?.instructions.matchAll(new RegExp("`(" + expected.appId + "\\.[a-z0-9.-]+)`", "g")) ?? [])].map(
        (match) => match[1]!,
      );
      const source = await Bun.file(new URL(expected.source, import.meta.url)).text();
      const declared = [...source.matchAll(/^    "([a-z0-9.-]+)": \{/gm)].map((match) => `${expected.appId}.${match[1]!}`);
      expect([...new Set(namedCapabilities)].sort()).toEqual(declared.sort());
    }

    for (const skill of inputs) {
      expect(validateAiSkillDescription(skill.description)).toBe(skill.description);
      expect(validateAiSkillInstructions(skill.instructions)).toBe(skill.instructions);
    }

    expect(inputs.some((candidate) => candidate.name === "cloud-tools")).toBeFalse();
  });
});
