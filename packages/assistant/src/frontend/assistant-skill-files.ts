import type { AiSkill } from "@k2b/cloud/ai";
import {
  AI_SKILL_REFERENCE_MAX_ITEMS,
  AI_SKILL_REFERENCE_PATH_PATTERN,
  AI_SKILL_REFERENCES_MAX_CHARS,
  type AiSkillDocument,
  type AiSkillReferenceInput,
  parseAiSkillMarkdown,
  serializeAiSkillMarkdown,
  validateAiSkillReferences,
} from "@k2b/cloud/ai/browser";
import { createZip, downloadFileFromContent, extractZip } from "@k2b/stdlib/browser";
import { assistantBrowserCopy, assistantBrowserText } from "./ui-copy";

export type AiSkillImport = AiSkillDocument & { references: AiSkillReferenceInput[]; skipped: string[] };

const decoder = new TextDecoder("utf-8", { fatal: true });
// Archivers add these on their own; they are not part of the Skill and not worth reporting.
const archiveNoise = (path: string): boolean => path.startsWith("__MACOSX/") || path.split("/").some((part) => part.startsWith("."));

const decodeMarkdown = (bytes: Uint8Array, path: string): string => {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(assistantBrowserCopy().invalidMarkdown({ path }));
  }
};

const safeArchivePath = (value: string): string => {
  const path = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
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
    .filter((entry) => !archiveNoise(entry.path));
  const skillFiles = entries.filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"));
  if (skillFiles.length !== 1) throw new Error(assistantBrowserText("Skill ZIP must contain exactly one SKILL.md."));
  const skillFile = skillFiles[0]!;
  const root = skillFile.path.slice(0, -"SKILL.md".length);
  const skipped = new Set<string>();
  const references = entries.flatMap((entry) => {
    if (entry === skillFile) return [];
    if (!entry.path.startsWith(root)) {
      skipped.add(entry.path);
      return [];
    }
    const path = entry.path.slice(root.length);
    if (!AI_SKILL_REFERENCE_PATH_PATTERN.test(path)) {
      const parts = path.split("/");
      let skippedPath = path;
      if (parts[0] === "references" && parts.length > 2) skippedPath = `references/${parts[1]}/`;
      else if (parts[0] !== "references" && parts.length > 1) skippedPath = `${parts[0]}/`;
      skipped.add(skippedPath);
      return [];
    }
    return [{ path, content: decodeMarkdown(entry.data, entry.path) }];
  });
  const document = parseAiSkillMarkdown(decodeMarkdown(skillFile.data, skillFile.path));
  return { ...document, references: validateAiSkillReferences(references), skipped: [...skipped].sort() };
};

export const readAiSkillImport = async (file: File): Promise<AiSkillImport> => {
  if (file.size > AI_SKILL_REFERENCES_MAX_CHARS + 2_000_000) throw new Error(assistantBrowserText("Skill import is too large."));
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.name.toLowerCase() === "skill.md") {
    return { ...parseAiSkillMarkdown(decodeMarkdown(bytes, file.name)), references: [], skipped: [] };
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
