import { describe, expect, test } from "bun:test";
import { AI_SKILL_CATALOG_MAX_CHARS, aiSkillCatalogChars, searchAiSkillCatalog, selectAiSkillCatalog } from "./skill-catalog";

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

  test("search returns matching complete entries and reports more", () => {
    const result = searchAiSkillCatalog(
      [
        { name: "cloud-mail", description: "Email and inbox workflows." },
        { name: "newsletter", description: "Draft an email newsletter." },
        { name: "cloud-spaces", description: "Tasks and events." },
      ],
      "email",
      1,
    );
    expect(result).toEqual({ skills: [{ name: "cloud-mail", description: "Email and inbox workflows." }], more: true });
  });
});
