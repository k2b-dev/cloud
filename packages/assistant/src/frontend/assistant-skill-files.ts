import { createZip, downloadFileFromContent, extractZip } from "@k2b/stdlib/browser";
import {
  AI_SKILL_REFERENCE_MAX_ITEMS,
  AI_SKILL_REFERENCES_MAX_CHARS,
  type AiSkillDocument,
  type AiSkillReferenceInput,
  parseAiSkillMarkdown,
  serializeAiSkillMarkdown,
  validateAiSkillReferences,
} from "@valentinkolb/cloud/ai/browser";
import type { AiSkill } from "@valentinkolb/cloud/ai";
import { assistantBrowserCopy, assistantBrowserText } from "./ui-copy";

export type AiSkillImport = AiSkillDocument & { references: AiSkillReferenceInput[] };

const decoder = new TextDecoder("utf-8", { fatal: true });
const ignoredArchivePath = (path: string): boolean => path.startsWith("__MACOSX/") || path.endsWith("/.DS_Store") || path === ".DS_Store";

const decodeMarkdown = (bytes: Uint8Array, path: string): string => {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(assistantBrowserCopy().invalidMarkdown({ path }));
  }
};

const safeArchivePath = (value: string): string => {
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(assistantBrowserCopy().unsafeArchivePath({ path: value }));
  }
  return path;
};

export const parseAiSkillArchive = async (bytes: Uint8Array): Promise<AiSkillImport> => {
  const extracted = await extractZip(bytes, {
    maxEntries: AI_SKILL_REFERENCE_MAX_ITEMS + 10,
    maxBytes: AI_SKILL_REFERENCES_MAX_CHARS + 150_000,
  });
  const entries = extracted
    .map((entry) => ({ path: safeArchivePath(entry.filename), data: entry.data }))
    .filter((entry) => !ignoredArchivePath(entry.path));
  const skillFiles = entries.filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"));
  if (skillFiles.length !== 1) throw new Error(assistantBrowserText("Skill ZIP must contain exactly one SKILL.md."));
  const skillFile = skillFiles[0]!;
  const root = skillFile.path.slice(0, -"SKILL.md".length);
  const references = entries.flatMap((entry) => {
    if (entry === skillFile) return [];
    if (!entry.path.startsWith(root)) throw new Error(assistantBrowserCopy().outsideSkillFolder({ path: entry.path }));
    const path = entry.path.slice(root.length);
    if (path.startsWith("scripts/") || path.startsWith("assets/")) {
      throw new Error(assistantBrowserText("This Cloud version supports SKILL.md and Markdown references, but not scripts or assets."));
    }
    if (!path.startsWith("references/") || !path.endsWith(".md")) {
      throw new Error(assistantBrowserCopy().unsupportedSkillFile({ path: entry.path }));
    }
    return [{ path, content: decodeMarkdown(entry.data, entry.path) }];
  });
  const document = parseAiSkillMarkdown(decodeMarkdown(skillFile.data, skillFile.path));
  return { ...document, references: validateAiSkillReferences(references) };
};

export const readAiSkillImport = async (file: File): Promise<AiSkillImport> => {
  if (file.size > AI_SKILL_REFERENCES_MAX_CHARS + 2_000_000) throw new Error(assistantBrowserText("Skill import is too large."));
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.name.toLowerCase() === "skill.md") {
    return { ...parseAiSkillMarkdown(decodeMarkdown(bytes, file.name)), references: [] };
  }
  if (file.name.toLowerCase().endsWith(".zip")) return parseAiSkillArchive(bytes);
  throw new Error(assistantBrowserText("Choose a SKILL.md or a skill ZIP."));
};

const skillDocument = (skill: Pick<AiSkill, "name" | "description" | "instructions" | "extraFrontmatter">): AiSkillDocument => ({
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  extraFrontmatter: skill.extraFrontmatter,
});

export const downloadAiSkillMarkdown = (skill: AiSkill): void => {
  downloadFileFromContent(serializeAiSkillMarkdown(skillDocument(skill)), "SKILL.md", "text/markdown;charset=utf-8");
};

export const downloadAiSkillZip = async (skill: AiSkill): Promise<void> => {
  const root = `${skill.name}/`;
  const archive = await createZip([
    { filename: `${root}SKILL.md`, source: serializeAiSkillMarkdown(skillDocument(skill)) },
    ...skill.references.map((reference) => ({ filename: `${root}${reference.path}`, source: reference.content })),
  ]);
  downloadFileFromContent(archive, `${skill.name}.zip`, "application/zip");
};
