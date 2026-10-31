import { z } from "zod";
import type { RequestAuthority } from "../server/middleware/auth";
import { AI_TOOL_UNAVAILABLE_REASONS } from "./capabilities";
import { AI_SKILL_FILE_MOUNT } from "./file-mount";
import type { AiResourceContext } from "./projects-authorization";
import { AI_SHORT_ID_PATTERN } from "./short-id";
import { type AiSkillCatalogEntry, mergeAiSkillCatalog, rankAiSkillCatalog, searchAiSkillCatalog } from "./skill-catalog";
import { AI_SKILL_NAME_MAX_CHARS, AI_SKILL_NAME_PATTERN } from "./skill-format";
import { aiSkills } from "./skills";
import { defineAiTool } from "./tools";

/** Explicit selections use the same permission check and turn snapshot as load_skill. */
export async function loadSelectedAiSkills(
  ids: readonly string[],
  turnId: string,
  subject: AiResourceContext | null,
  allowed: boolean,
  authority: RequestAuthority | null = null,
) {
  const loaded = [];
  for (const id of new Set(ids)) {
    if (!subject || !allowed) throw new Error("The selected Skill requires a model and tool scope that allow Skills.");
    const skill = await aiSkills.loadForTurn(turnId, { id }, subject, authority);
    if (!skill) throw new Error(`Selected Skill ${id} is unavailable or access was revoked.`);
    loaded.push({
      name: skill.name,
      revision: skill.revision,
      instructions: skill.instructions,
      files: skill.files.map((file) => file.path),
    });
  }
  return loaded;
}

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

const LoadedToolSchema = z.object({ name: z.string(), call: z.string() });

export const CloudAiLoadSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  revision: z.number().int().positive(),
  instructions: z.string(),
  mount: z.string(),
  files: z.array(z.string()),
  /** The tools the Skill lists in `load-tools`, loaded as load_tools would load them. */
  tools: z
    .object({
      loaded: z.array(LoadedToolSchema),
      alreadyLoaded: z.array(LoadedToolSchema),
      unavailable: z.array(z.object({ name: z.string(), reason: z.enum(AI_TOOL_UNAVAILABLE_REASONS) })),
      evicted: z.array(z.string()),
    })
    .optional(),
});

export const createCloudAiLoadSkillTool = (subject: AiResourceContext, authority: RequestAuthority | null = null) =>
  defineAiTool({
    name: "load_skill",
    description:
      "Load one available Agent Skill by its exact name or attached core.ai.skill ID for the current turn. This rechecks Cloud read permission, pins the skill revision, returns its SKILL.md instructions, and mounts its immutable files read-only below /skills/<name>. Load again in a later turn before reading its reference files; historical load results do not mount files in this turn. The tools a Skill names for itself are loaded with it, as load_tools would: from the next model turn, call each one in `tools.loaded` or `tools.alreadyLoaded` by its `call` name without searching or loading it again.",
    inputSchema: CloudAiLoadSkillInputSchema,
    outputSchema: CloudAiLoadSkillOutputSchema,
    approval: "never",
  }).server(async (input, ctx) => {
    if (!ctx.turnId) throw new Error("load_skill requires a turn context.");
    const selector = input.id ? { id: input.id } : input.name;
    const snapshot = selector ? await aiSkills.loadForTurn(ctx.turnId, selector, subject, authority) : null;
    if (!snapshot) throw new Error(`Skill "${input.id ?? input.name}" is unavailable or access was revoked.`);
    // A Skill grants nothing: its tools pass the same catalog, scope, and grant checks as load_tools, and every call is authorized.
    const tools = snapshot.loadTools.length && ctx.loadTools ? await ctx.loadTools(snapshot.loadTools) : undefined;
    return {
      name: snapshot.name,
      description: snapshot.description,
      revision: snapshot.revision,
      instructions: snapshot.instructions,
      mount: `${AI_SKILL_FILE_MOUNT}/${snapshot.name}`,
      files: snapshot.files.map((file) => file.path),
      ...(tools
        ? { tools: { loaded: tools.loaded, alreadyLoaded: tools.alreadyLoaded, unavailable: tools.unavailable, evicted: tools.evicted } }
        : {}),
    };
  });

export const CloudAiSearchSkillsInputSchema = z.object({
  query: z.string().trim().min(1).max(200).describe("Words from the Skill name or description; minor typos are tolerated."),
  limit: z.number().int().min(1).max(20).default(10),
});

export const CloudAiSearchSkillsOutputSchema = z.object({
  skills: z.array(z.object({ name: z.string(), description: z.string(), source: z.literal("local").optional() })),
  more: z.boolean(),
});

export const createCloudAiSearchSkillsTool = (
  subject: AiResourceContext | null,
  localSkills: readonly AiSkillCatalogEntry[] = [],
  authority: RequestAuthority | null = null,
) =>
  defineAiTool({
    name: "search_skills",
    description:
      "Search enabled Assistant Skills omitted from the bounded system-prompt catalog. Search names and descriptions with short domain or workflow terms; minor typos are tolerated. Then load_skill with an exact returned Cloud name, or load_local_skill for a result with source local.",
    inputSchema: CloudAiSearchSkillsInputSchema,
    outputSchema: CloudAiSearchSkillsOutputSchema,
    approval: "never",
  }).server(async (input) => {
    const result = subject
      ? await aiSkills.search(subject, input.query, input.limit + localSkills.length, { modelInvocableOnly: true, authority })
      : { skills: [], more: false };
    const cloud = result.skills.map(({ name, description }) => ({ name, description }));
    if (!localSkills.length) return { skills: cloud, more: result.more };
    const localMatches = new Set(searchAiSkillCatalog(localSkills, input.query).map((skill) => skill.name));
    const matches = rankAiSkillCatalog(
      mergeAiSkillCatalog(cloud, localSkills).filter((skill) => skill.source !== "local" || localMatches.has(skill.name)),
      input.query,
    );
    return { skills: matches.slice(0, input.limit), more: result.more || matches.length > input.limit };
  });
