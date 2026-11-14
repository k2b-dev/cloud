import { expect, test } from "bun:test";
import { assistantMessages } from "./messages";
import { assistantSkillPresentation } from "./skill-presentation";
import { missingAssistantGermanText } from "./ui-copy";

test("Assistant messages contain matching locale contracts", () => {
  expect(assistantMessages.check()).toEqual([]);
});

test("literal Assistant text calls have a German translation", async () => {
  const values = new Set<string>();
  const sourceFiles = new Bun.Glob("**/*.{ts,tsx}");
  for await (const path of sourceFiles.scan({ cwd: import.meta.dir, absolute: true })) {
    if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
    const source = await Bun.file(path).text();
    for (const match of source.matchAll(/\b(?:text|assistantBrowserText)\(\s*(["'])(.*?)\1/g)) {
      if (match[2]) values.add(match[2]);
    }
  }

  expect(missingAssistantGermanText(values)).toEqual([]);
});

test("people never read an internal component name such as Core in Assistant text", () => {
  for (const locale of assistantMessages.locales) {
    const { t } = assistantMessages.resolve([locale]);
    const internal = Object.entries(t).filter(([, value]) => typeof value === "string" && /\bCore\b/.test(value));
    expect(internal.map(([key]) => `${locale}.${key}`)).toEqual([]);
  }
});

// Resolve shipped declarations before test timers start; the assertions exercise the catalog, not cold module loading.
const shippedSkills: { appId: string; name: string; description: string }[] = [];
const packagesDir = new URL("../../../", import.meta.url).pathname;
for await (const path of new Bun.Glob("*/src/skills.ts").scan({ cwd: packagesDir, absolute: true })) {
  // CLI skill-file tooling also uses this filename; only app declarations export SKILLS.
  if (!(await Bun.file(path).text()).includes("export const SKILLS")) continue;
  const appId = path.slice(packagesDir.length).split("/")[0]!;
  const { SKILLS }: { SKILLS: readonly { name: string; description: string }[] } = await import(path);
  shippedSkills.push(...SKILLS.map(({ name, description }) => ({ appId, name, description })));
}

test("every shipped built-in Skill has menu copy in every Assistant locale", () => {
  for (const { appId, ...skill } of shippedSkills) {
    for (const locale of assistantMessages.locales) {
      const copy = assistantSkillPresentation({ ...skill, source: { appId, appName: appId } }, locale);
      expect(copy.title, `${locale}: ${appId}.${skill.name}`).not.toBeEmpty();
      expect(copy.description, `${locale}: ${appId}.${skill.name}`).not.toBeEmpty();
      if (locale === assistantMessages.baseLocale) expect(copy).toEqual({ title: skill.name, description: skill.description });
      else expect(copy.description, `${locale}: ${appId}.${skill.name}`).not.toBe(skill.description);
    }
  }
  expect(shippedSkills.length).toBeGreaterThan(0);
});
