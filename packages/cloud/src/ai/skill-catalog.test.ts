import { describe, expect, test } from "bun:test";
import { AI_SKILL_CATALOG_MAX_CHARS, aiSkillCatalogChars, mergeAiSkillCatalog, selectAiSkillCatalog } from "./skill-catalog";

describe("Assistant Skill catalog", () => {
  test("keeps a fitting catalog complete and in source order", () => {
    const source = [
      { name: "cloud-mail", description: "Read and write email." },
      { name: "cloud-spaces", description: "Manage tasks and events." },
    ];
    expect(selectAiSkillCatalog(source, 128_000, "email")).toEqual({ skills: source, omitted: 0 });
  });

  test("keeps whole relevant entries within the hard bound", () => {
    const source = Array.from({ length: 12 }, (_, index) => ({
      name: index === 11 ? "cloud-mail" : `workflow-${index}`,
      description: `${index === 11 ? "Email inbox messages. " : "Generic workflow. "}${String(index).repeat(980)}`,
    }));
    const selected = selectAiSkillCatalog(source, 128_000, "email inbox");

    expect(selected.omitted).toBeGreaterThan(0);
    expect(selected.skills[0]?.name).toBe("cloud-mail");
    expect(selected.skills[0]?.description).toBe(source[11]!.description);
    expect(selected.skills.some((skill) => skill.description.endsWith("…"))).toBeFalse();
    expect(aiSkillCatalogChars(selected.skills)).toBeLessThanOrEqual(AI_SKILL_CATALOG_MAX_CHARS);
  });
});

test("local Skills hide Cloud names and share the catalog budget including markers", () => {
  const local = Array.from({ length: 12 }, (_, index) => ({
    name: `workflow-${index}`,
    description: "Local workflow. ".repeat(30),
    source: "local" as const,
  }));
  const merged = mergeAiSkillCatalog(
    [
      { name: "workflow-0", description: "Hidden Cloud rules." },
      { name: "cloud-mail", description: "Email." },
    ],
    local,
  );
  expect(merged.filter((skill) => skill.name === "workflow-0")).toEqual([local[0]!]);
  const selected = selectAiSkillCatalog(merged, 16_000, "workflow");
  expect(selected.omitted).toBeGreaterThan(0);
  expect(selected.skills.some((skill) => skill.source === "local")).toBeTrue();
  expect(aiSkillCatalogChars(selected.skills)).toBeLessThanOrEqual(16_000 * 0.02 * 4);
  expect(aiSkillCatalogChars([{ name: "invoice", description: "Read", source: "local" }])).toBe("- invoice [local]: Read".length);
});
