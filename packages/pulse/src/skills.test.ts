import { expect, test } from "bun:test";
import { aiSkillLoadTools } from "@k2b/cloud/ai";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { pulseCapabilities } from "./capabilities";
import { SKILLS } from "./skills";

test("Skills load only capabilities the app declares", () => {
  const manifest = compileCapabilityManifest("pulse", pulseCapabilities);
  const declared = [...manifest.queries, ...manifest.actions].map((operation) => `pulse.${operation.localId}`);
  for (const skill of SKILLS) {
    const names = aiSkillLoadTools(skill.extraFrontmatter);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(declared).toContain(name);
  }
});
