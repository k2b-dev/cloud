import { z } from "zod";
import type { AccessSubject } from "../server";
import { AI_SKILL_FILE_MOUNT } from "./file-mount";
import { AI_SHORT_ID_PATTERN } from "./short-id";
import { searchAiSkillCatalog } from "./skill-catalog";
import { AI_SKILL_NAME_MAX_CHARS, AI_SKILL_NAME_PATTERN } from "./skill-format";
import { aiSkills } from "./skills";
import { defineAiTool } from "./tools";

export const CloudAiLoadSkillInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(AI_SKILL_NAME_MAX_CHARS)
      .regex(AI_SKILL_NAME_PATTERN)
      .describe("Exact skill name from the available-skills catalog.")
      .optional(),
    id: z
      .string()
      .regex(AI_SHORT_ID_PATTERN)
      .describe("Public ID from an attached core.ai.skill resource. Use either id or name.")
      .optional(),
  })
  .refine((input) => Boolean(input.name) !== Boolean(input.id), "Provide either a Skill name or ID.");

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
      "Load one available Agent Skill by its exact name or attached core.ai.skill ID for the current turn. This rechecks Cloud read permission, pins the skill revision, returns its SKILL.md instructions, and mounts its immutable files read-only below /skills/<name>. Load again in a later turn before reading its reference files; historical load results do not mount files in this turn.",
    inputSchema: CloudAiLoadSkillInputSchema,
    outputSchema: CloudAiLoadSkillOutputSchema,
    approval: "never",
  }).server(async (input, ctx) => {
    if (!ctx.turnId) throw new Error("load_skill requires a turn context.");
    const selector = input.id ? { id: input.id } : input.name;
    const snapshot = selector ? await aiSkills.loadForTurn(ctx.turnId, selector, subject) : null;
    if (!snapshot) throw new Error(`Skill "${input.id ?? input.name}" is unavailable or access was revoked.`);
    return {
      name: snapshot.name,
      description: snapshot.description,
      revision: snapshot.revision,
      instructions: snapshot.instructions,
      mount: `${AI_SKILL_FILE_MOUNT}/${snapshot.name}`,
      files: snapshot.files.map((file) => file.path),
    };
  });

export const CloudAiSearchSkillsInputSchema = z.object({
  query: z.string().trim().min(1).max(200).describe("Short English terms describing the workflow or domain to find."),
  limit: z.number().int().min(1).max(20).default(10),
});

export const CloudAiSearchSkillsOutputSchema = z.object({
  skills: z.array(z.object({ name: z.string(), description: z.string() })),
  more: z.boolean(),
});

export const createCloudAiSearchSkillsTool = (subject: AccessSubject) =>
  defineAiTool({
    name: "search_skills",
    description:
      "Search enabled Assistant Skills omitted from the bounded system-prompt catalog. Use short English domain or workflow terms, then load_skill with an exact returned name.",
    inputSchema: CloudAiSearchSkillsInputSchema,
    outputSchema: CloudAiSearchSkillsOutputSchema,
    approval: "never",
  }).server(async (input) => {
    const skills = (await aiSkills.list(subject)).filter((skill) => skill.enabled);
    return searchAiSkillCatalog(skills, input.query, input.limit);
  });
