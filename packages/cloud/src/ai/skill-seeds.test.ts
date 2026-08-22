import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { seedCloudAiSkills } from "./skill-seeds";
import { aiSkills } from "./skills";

afterEach(() => mock.restore());

describe("Cloud AI Skill seeds", () => {
  test("publishes ordinary single-file Skills once", async () => {
    const seedOnce = spyOn(aiSkills, "seedOnce").mockResolvedValue();

    await seedCloudAiSkills();

    expect(seedOnce).toHaveBeenCalledTimes(2);
    const inputs = seedOnce.mock.calls.map(([input]) => input);
    const input = inputs.find((candidate) => candidate.name === "skill-creator");
    expect(input).toMatchObject({ key: "core:skill-creator", name: "skill-creator" });
    expect(input?.description).toContain("Use this whenever");
    expect(input?.instructions).toContain("short, clear, action-oriented description");
    expect(input?.instructions).toContain("main discovery signal");
    expect(input?.instructions).toContain("Do not invent scripts");
    expect(input?.instructions).toContain("core.ai.skill.create");
    expect(input?.instructions).toContain("core.ai.skill.reference.set");
    expect(input?.instructions).toContain("core.ai.skill.enabled.set");
    expect(input?.references).toBeUndefined();

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
  });
});
