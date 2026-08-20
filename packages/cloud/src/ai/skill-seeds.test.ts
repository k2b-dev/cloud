import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { seedCloudAiSkills } from "./skill-seeds";
import { aiSkills } from "./skills";

afterEach(() => mock.restore());

describe("Cloud AI Skill seeds", () => {
  test("publishes one ordinary single-file Skill Creator once with the exact capability family", async () => {
    const seedOnce = spyOn(aiSkills, "seedOnce").mockResolvedValue();

    await seedCloudAiSkills();

    expect(seedOnce).toHaveBeenCalledTimes(1);
    const input = seedOnce.mock.calls[0]?.[0];
    expect(input).toMatchObject({ key: "core:skill-creator", name: "skill-creator" });
    expect(input?.description).toContain("Use this whenever");
    expect(input?.instructions).toContain("short, clear, action-oriented description");
    expect(input?.instructions).toContain("main discovery signal");
    expect(input?.instructions).toContain("Do not invent scripts");
    expect(input?.instructions).toContain("core.ai.skill.create");
    expect(input?.instructions).toContain("core.ai.skill.reference.set");
    expect(input?.instructions).toContain("core.ai.skill.enabled.set");
    expect(input?.references).toBeUndefined();
  });
});
