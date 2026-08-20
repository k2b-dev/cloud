import { z } from "zod";
import type { AccessSubject } from "../server";
import { AI_SKILL_FILE_MOUNT } from "./file-mount";
import { AI_SKILL_NAME_MAX_CHARS, AI_SKILL_NAME_PATTERN } from "./skill-format";
import { aiSkills } from "./skills";
import { defineAiTool } from "./tools";

export const CloudAiLoadSkillInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(AI_SKILL_NAME_MAX_CHARS)
    .regex(AI_SKILL_NAME_PATTERN)
    .describe("Exact skill name from the available-skills catalog."),
});

export const CloudAiLoadSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  revision: z.number().int().positive(),
  instructions: z.string(),
  mount: z.string(),
  files: z.array(z.string()),
});

export const createCloudAiLoadSkillTool = (subject: AccessSubject) =>
  defineAiTool({
    name: "load_skill",
    description:
      "Load one available Agent Skill by its exact name for the current turn. This rechecks Cloud read permission, pins the skill revision, returns its SKILL.md instructions, and mounts its immutable files read-only below /skills/<name>.",
    inputSchema: CloudAiLoadSkillInputSchema,
    outputSchema: CloudAiLoadSkillOutputSchema,
    approval: "never",
    promptHint: "activate a relevant available skill before following its instructions or reading its reference files.",
  }).server(async (input, ctx) => {
    if (!ctx.turnId) throw new Error("load_skill requires a turn context.");
    const snapshot = await aiSkills.loadForTurn(ctx.turnId, input.name, subject);
    if (!snapshot) throw new Error(`Skill "${input.name}" is unavailable or access was revoked.`);
    return {
      name: snapshot.name,
      description: snapshot.description,
      revision: snapshot.revision,
      instructions: snapshot.instructions,
      mount: `${AI_SKILL_FILE_MOUNT}/${snapshot.name}`,
      files: snapshot.files.map((file) => file.path),
    };
  });
