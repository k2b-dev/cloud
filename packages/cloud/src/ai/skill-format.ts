import { parseDocument, stringify } from "yaml";

export const AI_SKILL_NAME_MAX_CHARS = 64;
export const AI_SKILL_DESCRIPTION_MAX_CHARS = 1024;
export const AI_SKILL_INSTRUCTIONS_MAX_CHARS = 100_000;
export const AI_SKILL_INSTRUCTIONS_MAX_LINES = 500;
export const AI_SKILL_REFERENCE_MAX_CHARS = 100_000;
export const AI_SKILL_REFERENCE_MAX_ITEMS = 50;
export const AI_SKILL_REFERENCES_MAX_CHARS = 1_000_000;
export const AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS = 20_000;

export const AI_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const AI_SKILL_REFERENCE_PATH_PATTERN = /^references\/[a-z0-9][a-z0-9._-]*\.md$/;

export type AiSkillExtraFrontmatter = Record<string, unknown>;

export type AiSkillReferenceInput = {
  path: string;
  content: string;
};

export type AiSkillDocument = {
  name: string;
  description: string;
  instructions: string;
  extraFrontmatter: AiSkillExtraFrontmatter;
};

const OPTIONAL_FRONTMATTER_FIELDS = new Set(["license", "compatibility", "metadata", "allowed-tools"]);

const assertJsonValue = (value: unknown, path: string): void => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`);
    return;
  }
  throw new Error(`${path} must contain only YAML values that can be represented as JSON.`);
};

export const validateAiSkillName = (value: string): string => {
  const name = value.trim();
  if (!name || name.length > AI_SKILL_NAME_MAX_CHARS || !AI_SKILL_NAME_PATTERN.test(name)) {
    throw new Error("Skill name must use 1-64 lowercase letters, numbers, and single hyphens between words.");
  }
  return name;
};

export const validateAiSkillDescription = (value: string): string => {
  const description = value.trim();
  if (!description || description.length > AI_SKILL_DESCRIPTION_MAX_CHARS) {
    throw new Error(`Skill description must use 1-${AI_SKILL_DESCRIPTION_MAX_CHARS} characters.`);
  }
  return description;
};

export const validateAiSkillInstructions = (value: string): string => {
  const instructions = value.trim();
  const lines = instructions ? instructions.split(/\r?\n/).length : 0;
  if (!instructions) throw new Error("Skill instructions are required.");
  if (instructions.length > AI_SKILL_INSTRUCTIONS_MAX_CHARS) {
    throw new Error(`Skill instructions exceed ${AI_SKILL_INSTRUCTIONS_MAX_CHARS} characters.`);
  }
  if (lines > AI_SKILL_INSTRUCTIONS_MAX_LINES) {
    throw new Error(`SKILL.md must stay at or below ${AI_SKILL_INSTRUCTIONS_MAX_LINES} instruction lines.`);
  }
  return instructions;
};

export const validateAiSkillExtraFrontmatter = (value: AiSkillExtraFrontmatter = {}): AiSkillExtraFrontmatter => {
  for (const key of Object.keys(value)) {
    if (!OPTIONAL_FRONTMATTER_FIELDS.has(key)) {
      throw new Error(`Unsupported SKILL.md frontmatter field "${key}".`);
    }
  }
  assertJsonValue(value, "Skill frontmatter");
  if (JSON.stringify(value).length > AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS) {
    throw new Error(`Optional SKILL.md frontmatter exceeds ${AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS} characters.`);
  }
  return structuredClone(value);
};

export const validateAiSkillReferences = (references: readonly AiSkillReferenceInput[]): AiSkillReferenceInput[] => {
  if (references.length > AI_SKILL_REFERENCE_MAX_ITEMS) {
    throw new Error(`A skill can contain at most ${AI_SKILL_REFERENCE_MAX_ITEMS} reference files.`);
  }
  const seen = new Set<string>();
  let totalChars = 0;
  return references.map((reference) => {
    const path = reference.path.trim().replace(/\\/g, "/");
    if (!AI_SKILL_REFERENCE_PATH_PATTERN.test(path)) {
      throw new Error(`Reference path "${path}" must match references/<name>.md.`);
    }
    if (seen.has(path)) throw new Error(`Reference path "${path}" is duplicated.`);
    seen.add(path);
    const content = reference.content.replace(/\r\n/g, "\n");
    if (content.length > AI_SKILL_REFERENCE_MAX_CHARS) {
      throw new Error(`Reference "${path}" exceeds ${AI_SKILL_REFERENCE_MAX_CHARS} characters.`);
    }
    totalChars += content.length;
    if (totalChars > AI_SKILL_REFERENCES_MAX_CHARS) {
      throw new Error(`Skill references exceed ${AI_SKILL_REFERENCES_MAX_CHARS} total characters.`);
    }
    return { path, content };
  });
};

export const parseAiSkillMarkdown = (source: string): AiSkillDocument => {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SKILL.md must start with YAML frontmatter.");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter must end with a line containing ---.");
  const document = parseDocument(normalized.slice(4, end), { prettyErrors: true });
  if (document.errors.length) throw new Error(`Invalid SKILL.md frontmatter: ${document.errors[0]!.message}`);
  const frontmatter = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error("SKILL.md frontmatter must be a YAML object.");
  }
  const fields = { ...(frontmatter as Record<string, unknown>) };
  if (typeof fields.name !== "string") throw new Error("SKILL.md frontmatter requires a string name.");
  if (typeof fields.description !== "string") throw new Error("SKILL.md frontmatter requires a string description.");
  const name = validateAiSkillName(fields.name);
  const description = validateAiSkillDescription(fields.description);
  delete fields.name;
  delete fields.description;
  return {
    name,
    description,
    instructions: validateAiSkillInstructions(normalized.slice(end + 5)),
    extraFrontmatter: validateAiSkillExtraFrontmatter(fields),
  };
};

export const serializeAiSkillMarkdown = (skill: AiSkillDocument): string => {
  const name = validateAiSkillName(skill.name);
  const description = validateAiSkillDescription(skill.description);
  const instructions = validateAiSkillInstructions(skill.instructions);
  const extraFrontmatter = validateAiSkillExtraFrontmatter(skill.extraFrontmatter);
  const frontmatter = stringify({ name, description, ...extraFrontmatter }, { lineWidth: 0 }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${instructions}\n`;
};
