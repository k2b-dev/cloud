import { type SQL, sql } from "bun";
import { z } from "zod";
import { logger } from "../services/logging";
import { AI_SKILL_CATALOG_MAX_CHARS, aiSkillCatalogChars } from "./skill-catalog";
import { type AiSkillContent, canonicalHash, contentHash, validateSkillContent } from "./skill-content";
import { type AiSkillExtraFrontmatter, type AiSkillReferenceInput, parseAiSkillMarkdown } from "./skill-format";

export type AppSkillDefinition = Readonly<{
  name: string;
  description: string;
  instructions: string;
  extraFrontmatter: AiSkillExtraFrontmatter;
  references: readonly AiSkillReferenceInput[];
  hash: string;
}>;

const freezeJson = (value: unknown): void => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
};

export const validateAppSkillContent = (input: AiSkillContent): AppSkillDefinition => {
  try {
    const fields = validateSkillContent(input);
    fields.instructions = fields.instructions.replace(
      /\]\((references\/[a-z0-9][a-z0-9._-]*\.md)\)/g,
      (_, path: string) => `](/skills/${fields.name}/${path})`,
    );
    // Link expansion must respect the same instruction size limits.
    const validated = validateSkillContent(fields);
    const paths = new Set(validated.references.map((ref) => ref.path));
    for (const match of validated.instructions.matchAll(/references\/[^\s\])`"'<>]+\.md/g)) {
      const path = match[0];
      const owner = validated.instructions.slice(0, match.index).match(/\/skills\/([a-z0-9-]+)\/$/)?.[1];
      // A fully qualified link to another loaded Skill names that Skill's files, not this catalog entry's references.
      if (owner && owner !== validated.name) continue;
      if (!paths.has(path)) throw new Error(`Reference "${path}" is not declared.`);
    }
    const definition = { ...validated, hash: contentHash(validated) };
    freezeJson(definition);
    return definition;
  } catch (error) {
    throw new Error(`Skill "${input.name}": ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const skill = (input: { markdown: string; references?: Readonly<Record<string, string>> }): AppSkillDefinition => {
  const document = parseAiSkillMarkdown(input.markdown);
  return validateAppSkillContent({
    ...document,
    references: Object.entries(input.references ?? {}).map(([path, content]) => ({ path, content })),
  });
};

export const appSkillManifestHash = (skills: readonly AppSkillDefinition[]): string =>
  canonicalHash(skills.map(({ name, hash }) => ({ name, hash })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));

export const validateAppSkillCatalog = (skills: readonly AppSkillDefinition[]): readonly AppSkillDefinition[] => {
  const validated = skills.map(validateAppSkillContent);
  if (new Set(validated.map((entry) => entry.name)).size !== validated.length) throw new Error("App skill names must be unique.");
  if (aiSkillCatalogChars(validated) > AI_SKILL_CATALOG_MAX_CHARS)
    throw new Error(
      `App skills exceed the ${AI_SKILL_CATALOG_MAX_CHARS}-character always-visible Assistant catalog budget; this bounds the number of skills per app.`,
    );
  return Object.freeze(validated);
};

// Catalog JSON is untrusted even though application authors use skill() to produce it.
const StoredSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  extraFrontmatter: z.record(z.string(), z.unknown()),
  references: z.array(z.object({ path: z.string(), content: z.string() })),
});
export const parseStoredAppSkill = (value: unknown): AppSkillDefinition => validateAppSkillContent(StoredSkillSchema.parse(value));

export const registerAppSkills = async (
  appId: string,
  skills: readonly AppSkillDefinition[],
  manifestHash: string,
  db: SQL = sql,
): Promise<void> => {
  try {
    await db.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '10s'`.simple();
      const renewed = await tx`UPDATE ai.app_skill_catalogs SET last_seen_at = now()
        WHERE app_id = ${appId} AND manifest_hash = ${manifestHash} RETURNING app_id`;
      if (renewed.length) return;
      await tx`INSERT INTO ai.app_skill_catalogs(app_id, manifest_hash, skills)
        VALUES (${appId}, ${manifestHash}, (${JSON.stringify(skills)}::text)::jsonb)
        ON CONFLICT (app_id, manifest_hash) DO UPDATE SET last_seen_at = now()`;
    });
  } catch (error) {
    // Bun's PostgresError carries the SQLSTATE in `errno`; `code` names the driver error class.
    const state = error && typeof error === "object" ? ("errno" in error ? error.errno : "code" in error ? error.code : null) : null;
    if (["42P01", "3F000", "42703"].includes(String(state))) {
      logger("ai:app-skills").warn("App skill schema is not available yet; next heartbeat will retry", { appId });
      return;
    }
    throw error;
  }
};
