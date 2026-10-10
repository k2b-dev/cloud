import { expect, test } from "bun:test";
import { SKILLS } from "./skills";

test("ships its Skills with every reference linked from the instructions", () => {
  expect(SKILLS.map((skill) => skill.name)).toEqual(["cloud-notebooks"]);
  for (const skill of SKILLS)
    for (const reference of skill.references) expect(skill.instructions).toContain(`/skills/${skill.name}/${reference.path}`);
});

test("app skill retains domain and declared cross-app guidance", async () => {
  const skill = SKILLS[0]!;
  const instructions = [skill.instructions, ...skill.references.map((ref) => ref.content)].join("\n");
  for (const text of [
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
  ])
    expect(instructions).toContain(text);
  const source = await Bun.file(new URL("./capabilities.ts", import.meta.url)).text();
  const declared = [...source.matchAll(/^    "([a-z0-9.-]+)": \{/gm)].map((match) => `notebooks.${match[1]}`);
  for (const match of instructions.matchAll(/`(notebooks\.[a-z0-9.-]+)`/g)) expect(declared).toContain(match[1]!);
});

test("Notebooks skill keeps safe partial editing and structure guidance", () => {
  expect(SKILLS[0]!.instructions).toContain("notebooks.note.children");
  expect(SKILLS[0]!.instructions).toContain("Never replace a complete note with a partial window");
  expect(SKILLS[0]!.references.map((ref) => ref.path)).toEqual(["references/structured-pages.md"]);
});

test("main instructions stay compact", () => {
  expect(SKILLS[0]!.instructions.length).toBeLessThan(5000);
});
