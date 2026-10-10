import { expect, test } from "bun:test";
import { SKILLS } from "./skills";

test("ships its Skills with every reference linked from the instructions", () => {
  expect(SKILLS.map((skill) => skill.name)).toEqual(["cloud-mail"]);
  for (const skill of SKILLS)
    for (const reference of skill.references) expect(skill.instructions).toContain(`/skills/${skill.name}/${reference.path}`);
});

test("Mail skill retains capability and reply guidance", async () => {
  const inputs = SKILLS;
  const mail = inputs.find((candidate) => candidate.name === "cloud-mail");
  expect(mail?.description).toContain("whenever a request involves Cloud Mail");
  expect(mail?.instructions).toContain("more specific loaded Skill overrides them");
  expect(mail?.instructions).toContain("mail.conversation.focus");
  expect(mail?.instructions).toContain("mail.draft.send.review");
  expect(mail?.instructions).toContain("let Mail derive reply recipients and threading");
  expect(mail?.instructions).toContain("Never introduce or sign as an AI or Cloud Assistant");
  expect(mail?.instructions).toContain("consider Contacts and its Skill rather than guessing an address");
  expect(mail?.instructions).toContain("consider Spaces and preserve a link to the mail conversation");
  expect(mail?.references).toEqual([]);

  const mentionedCapabilities = [...(mail?.instructions.matchAll(/`(mail\.[a-z0-9.-]+)`/g) ?? [])].map((match) => match[1]!);
  const capabilitySource = await Bun.file(new URL("./capabilities.ts", import.meta.url)).text();
  const declaredCapabilities = [...capabilitySource.matchAll(/^  (?:(?:"([a-z0-9.-]+)")|(search)): \{/gm)].map(
    (match) => `mail.${match[1] ?? match[2]}`,
  );
  for (const capability of mentionedCapabilities) expect(declaredCapabilities).toContain(capability);
  for (const capability of ["mail.mailbox.browse", "mail.message.read-content", "mail.draft.patch"]) {
    expect(mentionedCapabilities).toContain(capability);
  }
});

test("main instructions stay compact", () => {
  expect(SKILLS[0]!.instructions.length).toBeLessThan(5000);
});
