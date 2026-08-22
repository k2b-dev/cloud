import { AI_SKILL_DESCRIPTION_MAX_CHARS, AI_SKILL_NAME_MAX_CHARS } from "./skill-format";
import type { AiSkillSummary } from "./skills";

export const AI_SKILL_CATALOG_MAX_CHARS = 8_000;
const AI_SKILL_CATALOG_MIN_CHARS = AI_SKILL_NAME_MAX_CHARS + AI_SKILL_DESCRIPTION_MAX_CHARS + 8;

export type AiSkillCatalogEntry = Pick<AiSkillSummary, "name" | "description">;

const catalogLine = (skill: AiSkillCatalogEntry): string => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()}`;

const terms = (value: string): string[] => [
  ...new Set(
    value
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 2),
  ),
];

const relevance = (skill: AiSkillCatalogEntry, query: string): number => {
  const normalizedQuery = query.toLocaleLowerCase().trim();
  if (!normalizedQuery) return 0;
  const name = skill.name.toLocaleLowerCase();
  const description = skill.description.toLocaleLowerCase();
  let score = name.includes(normalizedQuery) ? 100 : 0;
  for (const term of terms(normalizedQuery)) {
    if (name.includes(term)) score += 20;
    if (description.includes(term)) score += 3;
  }
  return score;
};

const ranked = (skills: readonly AiSkillCatalogEntry[], query: string): AiSkillCatalogEntry[] =>
  skills
    .map((skill, index) => ({ skill, index, score: relevance(skill, query) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ skill }) => skill);

export const selectAiSkillCatalog = (
  skills: readonly AiSkillCatalogEntry[],
  contextWindow: number,
  query: string,
): { skills: AiSkillCatalogEntry[]; omitted: number } => {
  if (!skills.length) return { skills: [], omitted: 0 };
  const budget = Math.min(
    AI_SKILL_CATALOG_MAX_CHARS,
    Math.max(AI_SKILL_CATALOG_MIN_CHARS, contextWindow > 0 ? Math.floor(contextWindow * 0.02 * 4) : AI_SKILL_CATALOG_MAX_CHARS),
  );
  const normalized = skills.map((skill) => ({ name: skill.name, description: skill.description.replace(/\s+/g, " ").trim() }));
  if (normalized.map(catalogLine).join("\n").length <= budget) return { skills: normalized, omitted: 0 };

  const selected: AiSkillCatalogEntry[] = [];
  let used = 0;
  for (const skill of ranked(normalized, query)) {
    const size = catalogLine(skill).length + (selected.length ? 1 : 0);
    if (used + size > budget) continue;
    selected.push(skill);
    used += size;
  }
  return { skills: selected, omitted: normalized.length - selected.length };
};

export const searchAiSkillCatalog = (
  skills: readonly AiSkillCatalogEntry[],
  query: string,
  limit: number,
): { skills: AiSkillCatalogEntry[]; more: boolean } => {
  const normalized = skills.map((skill) => ({ name: skill.name, description: skill.description }));
  const matches = ranked(normalized, query).filter((skill) => relevance(skill, query) > 0);
  return { skills: matches.slice(0, limit), more: matches.length > limit };
};

export const aiSkillCatalogChars = (skills: readonly AiSkillCatalogEntry[]): number => skills.map(catalogLine).join("\n").length;
