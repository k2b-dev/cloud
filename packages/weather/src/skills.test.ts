import { expect, test } from "bun:test";
import { aiSkillLoadTools } from "@k2b/cloud/ai";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { weatherCapabilities } from "./capabilities";
import { SKILLS } from "./skills";

test("ships its Skills with every reference linked from the instructions", () => {
  expect(SKILLS.map((skill) => skill.name)).toEqual(["cloud-weather"]);
  for (const skill of SKILLS)
    for (const reference of skill.references) expect(skill.instructions).toContain(`/skills/${skill.name}/${reference.path}`);
});

test("app skill retains domain and declared cross-app guidance", async () => {
  const skill = SKILLS[0]!;
  const instructions = [skill.instructions, ...skill.references.map((ref) => ref.content)].join("\n");
  for (const text of ["unsaved German city", "only when the user asks", "time-sensitive estimates"]) expect(instructions).toContain(text);
  const source = await Bun.file(new URL("./capabilities.ts", import.meta.url)).text();
  const declared = [...source.matchAll(/^    "([a-z0-9.-]+)": \{/gm)].map((match) => `weather.${match[1]}`);
  for (const match of instructions.matchAll(/`(weather\.[a-z0-9.-]+)`/g)) expect(declared).toContain(match[1]!);
});

test("Weather skill retains coordinates fallback", () => {
  const weather = SKILLS[0]!;
  expect(weather?.instructions).toContain(
    'If city search is unavailable, use known coordinates with `weather.forecast.current` or `weather.forecast.get` and `source.kind = "coordinates"`',
  );
});

test("Skills load only capabilities the app declares", () => {
  const manifest = compileCapabilityManifest("weather", weatherCapabilities);
  const declared = [...manifest.queries, ...manifest.actions].map((operation) => `weather.${operation.localId}`);
  for (const skill of SKILLS) {
    const names = aiSkillLoadTools(skill.extraFrontmatter);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(declared).toContain(name);
  }
});
