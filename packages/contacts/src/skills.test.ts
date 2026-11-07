import { expect, test } from "bun:test";
import { aiSkillLoadTools } from "@k2b/cloud/ai";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { contactsCapabilities } from "./capabilities";
import { SKILLS } from "./skills";

test("ships its Skills with every reference linked from the instructions", () => {
  expect(SKILLS.map((skill) => skill.name)).toEqual(["cloud-contacts"]);
  for (const skill of SKILLS)
    for (const reference of skill.references) expect(skill.instructions).toContain(`/skills/${skill.name}/${reference.path}`);
});

test("app skill retains domain and declared cross-app guidance", async () => {
  const skill = SKILLS[0]!;
  const instructions = [skill.instructions, ...skill.references.map((ref) => ref.content)].join("\n");
  for (const text of ["recipient suggestions", "Collection fields", "Do not invent an email address", "consider Spaces"])
    expect(instructions).toContain(text);
  const source = await Bun.file(new URL("./capabilities.ts", import.meta.url)).text();
  const declared = [...source.matchAll(/^    "([a-z0-9.-]+)": \{/gm)].map((match) => `contacts.${match[1]}`);
  for (const match of instructions.matchAll(/`(contacts\.[a-z0-9.-]+)`/g)) expect(declared).toContain(match[1]!);
});

test("Skills load only capabilities the app declares", () => {
  const manifest = compileCapabilityManifest("contacts", contactsCapabilities);
  const declared = [...manifest.queries, ...manifest.actions].map((operation) => `contacts.${operation.localId}`);
  for (const skill of SKILLS) {
    const names = aiSkillLoadTools(skill.extraFrontmatter);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(declared).toContain(name);
  }
});
