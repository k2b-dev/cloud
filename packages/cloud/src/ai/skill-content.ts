import { createHash } from "node:crypto";
import {
  type AiSkillDocument,
  type AiSkillExtraFrontmatter,
  type AiSkillReferenceInput,
  validateAiSkillDescription,
  validateAiSkillExtraFrontmatter,
  validateAiSkillInstructions,
  validateAiSkillName,
  validateAiSkillReferences,
} from "./skill-format";

export type AiSkillContent = AiSkillDocument & { references: readonly AiSkillReferenceInput[] };

export const validateSkillContent = (input: {
  name: string;
  description: string;
  instructions: string;
  extraFrontmatter?: AiSkillExtraFrontmatter;
  references?: readonly AiSkillReferenceInput[];
}): AiSkillContent => ({
  name: validateAiSkillName(input.name),
  description: validateAiSkillDescription(input.description),
  instructions: validateAiSkillInstructions(input.instructions),
  extraFrontmatter: validateAiSkillExtraFrontmatter(input.extraFrontmatter),
  references: validateAiSkillReferences(input.references ?? []).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
});

// Keep the former template hash algorithm: key order and reference insertion order are immaterial.
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Skill content must be JSON.");
  return result;
};
export const canonicalHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const contentHash = (fields: AiSkillContent): string =>
  canonicalHash({
    name: fields.name,
    description: fields.description,
    instructions: fields.instructions,
    extraFrontmatter: fields.extraFrontmatter,
    references: [...fields.references].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });

/** How an installed app Skill relates to its app: the app's version, an administrator's override, or an override with a newer app version. */
export type AppSkillStatus = "current" | "modified" | "update_available";
export const appSkillStatus = (rowHash: string, sourceHash: string | null, appliedHash: string | null): AppSkillStatus =>
  rowHash === (sourceHash ?? appliedHash) ? "current" : sourceHash === null || sourceHash === appliedHash ? "modified" : "update_available";
