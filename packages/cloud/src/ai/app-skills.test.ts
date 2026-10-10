import { describe, expect, test } from "bun:test";
import { defineApp } from "../_internal/define-app";
import { inventory, publishedEntry } from "../_internal/define-app.test-fixture";
import { validateAppRegistryEntry } from "../_internal/registry-validation";
import { appSkillManifestHash, parseStoredAppSkill, registerAppSkills, skill } from "./app-skills";
import { AI_SKILL_CATALOG_MAX_CHARS } from "./skill-catalog";
import { appSkillStatus, canonicalHash, contentHash } from "./skill-content";
import {
  AI_SKILL_DESCRIPTION_MAX_CHARS,
  AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS,
  AI_SKILL_INSTRUCTIONS_MAX_CHARS,
  AI_SKILL_REFERENCE_MAX_CHARS,
  AI_SKILL_REFERENCE_MAX_ITEMS,
  AI_SKILL_REFERENCES_MAX_CHARS,
} from "./skill-format";

const markdown = (name = "inventory-counting", description = "Count a shelf.", instructions = "Count the items.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}\n`;

describe("App skill authoring", () => {
  test("parses user-import format, rewrites relative links, sorts and deeply freezes content", () => {
    const definition = skill({
      markdown: markdown("inventory-counting", "Count", "Read [Z](references/z.md) and references/a.md."),
      references: { "references/z.md": "Z\r\n", "references/a.md": "A" },
    });
    expect(definition.instructions).toBe("Read [Z](/skills/inventory-counting/references/z.md) and references/a.md.");
    expect(definition.references).toEqual([
      { path: "references/a.md", content: "A" },
      { path: "references/z.md", content: "Z\n" },
    ]);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.references)).toBe(true);
    expect(Object.isFrozen(definition.extraFrontmatter)).toBe(true);
  });
  test("keeps valid frontmatter and qualified links to another loaded skill", () => {
    const definition = skill({
      markdown: markdown("count", "Count", "Read /skills/other/references/rules.md.").replace(
        "---\n\n",
        "metadata:\n  owner: inventory\n---\n\n",
      ),
    });
    expect(definition.extraFrontmatter).toEqual({ metadata: { owner: "inventory" } });
    expect(Object.isFrozen(definition.extraFrontmatter.metadata)).toBe(true);
  });
  test("rejects undeclared relative, absolute and plain reference occurrences with the skill's name", () => {
    for (const instructions of ["[Read](references/typo.md)", "/skills/count/references/typo.md", "Read `references/typo.md`."]) {
      expect(() => skill({ markdown: markdown("count", "Count", instructions) })).toThrow(
        'Skill "count": Reference "references/typo.md" is not declared',
      );
    }
    expect(() => skill({ markdown: markdown(), references: { "../unsafe.md": "No" } })).toThrow("inventory-counting");
    expect(() => skill({ markdown: "No frontmatter" })).toThrow("frontmatter");
  });
  test("applies all content limits including after link expansion", () => {
    expect(() => skill({ markdown: markdown("count", "x".repeat(AI_SKILL_DESCRIPTION_MAX_CHARS + 1)) })).toThrow("description");
    expect(() => skill({ markdown: markdown("count", "Count", "x".repeat(AI_SKILL_INSTRUCTIONS_MAX_CHARS + 1)) })).toThrow("characters");
    expect(() => skill({ markdown: markdown("count", "Count", Array(501).fill("line").join("\n")) })).toThrow("500");
    expect(() =>
      skill({ markdown: markdown(), references: { "references/rules.md": "x".repeat(AI_SKILL_REFERENCE_MAX_CHARS + 1) } }),
    ).toThrow("rules.md");
    expect(() =>
      skill({
        markdown: markdown(),
        references: Object.fromEntries(Array.from({ length: AI_SKILL_REFERENCE_MAX_ITEMS + 1 }, (_, i) => [`references/r${i}.md`, ""])),
      }),
    ).toThrow("reference files");
    expect(() =>
      skill({
        markdown: markdown(),
        references: Object.fromEntries(
          Array.from({ length: AI_SKILL_REFERENCES_MAX_CHARS / AI_SKILL_REFERENCE_MAX_CHARS + 1 }, (_, i) => [
            `references/r${i}.md`,
            "x".repeat(AI_SKILL_REFERENCE_MAX_CHARS),
          ]),
        ),
      }),
    ).toThrow("total characters");
    expect(() =>
      skill({
        markdown: markdown().replace("---\n\n", `metadata: { value: ${"x".repeat(AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS)} }\n---\n\n`),
      }),
    ).toThrow("frontmatter exceeds");
    const link = "[Read](references/r.md)";
    expect(() =>
      skill({
        markdown: markdown("count", "Count", "x".repeat(AI_SKILL_INSTRUCTIONS_MAX_CHARS - link.length) + link),
        references: { "references/r.md": "" },
      }),
    ).toThrow("characters");
  });
  test("uses the unchanged canonical SHA256 algorithm and ignores JSON key/reference order", () => {
    const a = skill({
      markdown: markdown("count", "Count", "Read references/a.md and references/b.md."),
      references: { "references/b.md": "B", "references/a.md": "A" },
    });
    const b = skill({
      markdown: markdown("count", "Count", "Read references/a.md and references/b.md."),
      references: { "references/a.md": "A", "references/b.md": "B" },
    });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(contentHash(a));
    expect(a.hash).toBe(
      canonicalHash({
        name: a.name,
        description: a.description,
        instructions: a.instructions,
        extraFrontmatter: {},
        references: a.references,
      }),
    );
    expect(parseStoredAppSkill({ ...a, hash: "untrusted" }).hash).toBe(a.hash);
    expect(() => parseStoredAppSkill({ ...a, references: "untrusted" })).toThrow();
  });
  test("defineApp rejects duplicate names and bounds its catalog by the always-visible prompt budget", () => {
    const a = skill({ markdown: markdown() });
    expect(() => defineApp({ ...inventory, skills: [a, a] })).toThrow("unique");
    const large = Array.from({ length: Math.ceil(AI_SKILL_CATALOG_MAX_CHARS / 1024) }, (_, i) =>
      skill({ markdown: markdown(`count-${i}`, "x".repeat(1024)) }),
    );
    expect(() => defineApp({ ...inventory, skills: large })).toThrow("always-visible Assistant catalog budget");
  });
  test("publishes a stable manifest hash through the same registry as third-party apps", async () => {
    const a = skill({ markdown: markdown("count-a") }),
      b = skill({ markdown: markdown("count-b") });
    expect(appSkillManifestHash([a, b])).toBe(appSkillManifestHash([b, a]));
    expect(appSkillManifestHash([a, b])).toBe(
      canonicalHash([
        { name: a.name, hash: a.hash },
        { name: b.name, hash: b.hash },
      ]),
    );
    const entry = await publishedEntry({ ...inventory, skills: [a, b] });
    expect(entry.skills).toEqual({ manifestHash: appSkillManifestHash([a, b]) });
    expect(validateAppRegistryEntry(entry)).toBeNull();
    for (const skills of [{}, { manifestHash: 7 }, { manifestHash: "bad" }, "bad"])
      expect(validateAppRegistryEntry({ ...entry, skills })).toContain("skills");
    expect(validateAppRegistryEntry({ ...entry, skills: undefined })).toBeNull();
  });
});

test("admin status compares current content to source and applied baseline, including pending migration sources", () => {
  expect(appSkillStatus("original", "original", "original")).toBe("current");
  expect(appSkillStatus("custom", "original", "original")).toBe("modified");
  expect(appSkillStatus("custom", "new", "original")).toBe("update_available");
  expect(appSkillStatus("new", "new", "original")).toBe("current");
  expect(appSkillStatus("original", null, "original")).toBe("current");
  expect(appSkillStatus("custom", null, "original")).toBe("modified");
  expect(appSkillStatus("custom", null, null)).toBe("modified");
});

test("an app keeps starting while Core has not created the catalog schema yet", async () => {
  const missing = Object.assign(new Error('relation "ai.app_skill_catalogs" does not exist'), {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: "42P01",
  });
  const failing = (error: Error) => ({ begin: async () => Promise.reject(error) }) as unknown as Parameters<typeof registerAppSkills>[3];
  const skills = [skill({ markdown: markdown() })];
  await expect(registerAppSkills("inventory", skills, appSkillManifestHash(skills), failing(missing))).resolves.toBeUndefined();
  const refused = Object.assign(new Error("permission denied"), { code: "ERR_POSTGRES_SERVER_ERROR", errno: "42501" });
  await expect(registerAppSkills("inventory", skills, appSkillManifestHash(skills), failing(refused))).rejects.toThrow("permission denied");
});
