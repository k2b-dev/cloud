import { lstat, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AiSkill, AiSkillSummary } from "@k2b/cloud/ai";
import {
  AI_SKILL_REFERENCE_MAX_CHARS,
  AI_SKILL_REFERENCE_MAX_ITEMS,
  AI_SKILL_REFERENCE_PATH_PATTERN,
  AI_SKILL_REFERENCES_MAX_CHARS,
  type AiSkillDocument,
  type AiSkillReferenceInput,
  parseAiSkillMarkdown,
  serializeAiSkillMarkdown,
  validateAiSkillReferences,
} from "@k2b/cloud/ai/browser";
import { arg, type CloudCliContext, cloudResourceUrl, command, flag } from "@k2b/cloud/cli";
import { maxSkillBytes } from "./local-context";
import { resolveLocalPath } from "./local-paths";
import { jsonRequest, printRows, printValue, queryString, readApi } from "./shared";

const listSkills = (ctx: CloudCliContext, search?: string): Promise<{ skills: AiSkillSummary[] }> =>
  readApi(ctx, `/skills${queryString({ q: search })}`);

const findSkill = async (ctx: CloudCliContext, name: string): Promise<AiSkillSummary | undefined> =>
  (await readApi<{ skills: AiSkillSummary[] }>(ctx, `/skills${queryString({ name })}`)).skills.find((skill) => skill.name === name);

// Names come first; anything else is tried as a Skill ID so the API answers with its own not-found error.
const getSkill = async (ctx: CloudCliContext, reference: string): Promise<AiSkill> => {
  const id = (await findSkill(ctx, reference))?.id ?? reference;
  return (await readApi<{ skill: AiSkill }>(ctx, `/skills/${encodeURIComponent(id)}`)).skill;
};

const readFolder = async (directory: string) => {
  const target = resolveLocalPath(directory, process.cwd());
  let dir: string;
  try {
    dir = await realpath(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error(`No SKILL.md in ${directory}.`);
    throw error;
  }
  const skipped: string[] = [];
  const inspect = async (path: string) => {
    let target = join(dir, path);
    let info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) {
      skipped.push(path);
      return null;
    }
    if (info.isSymbolicLink()) {
      const real = await realpath(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!real) {
        skipped.push(path);
        return null;
      }
      const fromRoot = relative(dir, real);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        if (path === "SKILL.md") throw new Error(`SKILL.md in ${directory} links outside the folder.`);
        skipped.push(`${path} (links outside the folder)`);
        return null;
      }
      target = real;
      info = await stat(target);
    }
    return { target, info };
  };
  const markdown = await inspect("SKILL.md");
  if (!markdown) throw new Error(`No SKILL.md in ${directory}.`);
  if (markdown.info.size > maxSkillBytes) throw new Error(`SKILL.md in ${directory} is too large (maximum ${maxSkillBytes} bytes).`);
  const document = parseAiSkillMarkdown(await Bun.file(markdown.target).text());
  const references: AiSkillReferenceInput[] = [];
  let referenceChars = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "SKILL.md") continue;
    const inspected = await inspect(entry.name);
    if (!inspected) continue;
    if (entry.name === "references" && inspected.info.isDirectory()) {
      for (const ref of await readdir(inspected.target, { withFileTypes: true })) {
        if (ref.name.startsWith(".")) continue;
        const path = `references/${ref.name}`;
        const reference = await inspect(path);
        if (!reference) continue;
        if (reference.info.isFile() && AI_SKILL_REFERENCE_PATH_PATTERN.test(path)) {
          if (references.length >= AI_SKILL_REFERENCE_MAX_ITEMS)
            throw new Error(`Too many Skill references (maximum ${AI_SKILL_REFERENCE_MAX_ITEMS}).`);
          const maxBytes = 4 * AI_SKILL_REFERENCE_MAX_CHARS;
          if (reference.info.size > maxBytes) throw new Error(`${path} is too large (maximum ${maxBytes} bytes).`);
          const content = await Bun.file(reference.target).text();
          referenceChars += content.length;
          if (referenceChars > AI_SKILL_REFERENCES_MAX_CHARS)
            throw new Error(`Skill references exceed ${AI_SKILL_REFERENCES_MAX_CHARS} characters at ${path}.`);
          references.push({ path, content });
        } else skipped.push(`${path}${reference.info.isDirectory() ? "/" : ""}`);
      }
    } else skipped.push(`${entry.name}${inspected.info.isDirectory() ? "/" : ""}`);
  }
  return { ...document, references: validateAiSkillReferences(references), skipped: skipped.sort() };
};

const content = (skill: AiSkillDocument & { references: AiSkillReferenceInput[] }) => ({
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  extraFrontmatter: skill.extraFrontmatter,
  references: [...skill.references].sort((a, b) => a.path.localeCompare(b.path)),
});

const existsError = (path: string): Error =>
  new Error(`${path} already exists. Use --force to replace SKILL.md and its references; other files in the folder stay.`);

// Check every target first so a refused pull writes nothing; `wx` still refuses a file that appears meanwhile.
const writeSkillFiles = async (dir: string, files: { path: string; content: string }[], force: boolean): Promise<void> => {
  for (const file of files) {
    const path = join(dir, file.path);
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing && (!force || !existing.isFile())) throw existsError(path);
  }
  for (const file of files) await mkdir(dirname(join(dir, file.path)), { recursive: true });
  for (const file of files) {
    const path = join(dir, file.path);
    await writeFile(path, file.content, { encoding: "utf8", flag: force ? "w" : "wx" }).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "EEXIST" ? existsError(path) : error;
    });
  }
};

export const assistantSkillCommands = [
  command("skills list", {
    summary: "List accessible Cloud Skills",
    flags: { search: flag.string({ description: "Search enabled Skills by name and description" }) },
    async run({ ctx, flags }) {
      const result = await listSkills(ctx, flags.search);
      printRows(
        ctx,
        {
          ...result,
          skills: result.skills.map((skill) => ({
            ...skill,
            permalink: cloudResourceUrl(ctx, { type: "core.ai.skill", id: skill.shortId }),
          })),
        },
        result.skills.map((skill) => ({
          name: skill.name,
          id: skill.id,
          permalink: cloudResourceUrl(ctx, { type: "core.ai.skill", id: skill.shortId }),
          source: skill.source?.appName ?? "-",
          enabled: skill.enabled ? "yes" : "no",
          start: skill.manualOnly ? "selected" : "auto",
          description: skill.description.replace(/\s+/g, " ").trim(),
        })),
        [{ key: "name" }, { key: "id" }, { key: "source" }, { key: "enabled" }, { key: "start" }, { key: "description" }],
      );
    },
  }),
  command("skills push", {
    summary: "Create or update a Cloud Skill from an Agent Skills folder",
    args: { dir: arg.required({ valueLabel: "dir" }) },
    flags: { force: flag.boolean({ description: "Replace a Cloud Skill that differs from the folder" }) },
    async run({ ctx, args, flags }) {
      const folder = await readFolder(args.dir);
      const fields = content(folder);
      const summary = await findSkill(ctx, folder.name);
      if (summary?.permission === "read") throw new Error(`You can use the Cloud Skill "${folder.name}" but not change it.`);
      let action: "created" | "updated" | "unchanged";
      let skill: AiSkill;
      let removedReferences: string[] = [];
      let text: string;
      if (summary) {
        skill = (await readApi<{ skill: AiSkill }>(ctx, `/skills/${encodeURIComponent(summary.id)}`)).skill;
        if (Bun.deepEquals(fields, content(skill))) {
          action = "unchanged";
          text = `Cloud Skill ${skill.name} is already up to date (revision ${skill.revision}).`;
        } else {
          removedReferences = skill.references
            .filter((ref) => !folder.references.some((next) => next.path === ref.path))
            .map((ref) => ref.path)
            .sort();
          if (!flags.force) {
            const changes: string[] = [];
            if (skill.description !== fields.description) changes.push("changes description");
            if (skill.instructions !== fields.instructions) changes.push("changes instructions");
            if (!Bun.deepEquals(skill.extraFrontmatter, fields.extraFrontmatter)) changes.push("changes frontmatter");
            const current = new Map(skill.references.map((ref) => [ref.path, ref.content]));
            const added = fields.references
              .filter((ref) => !current.has(ref.path))
              .map((ref) => ref.path)
              .sort();
            const replaced = fields.references
              .filter((ref) => current.has(ref.path) && current.get(ref.path) !== ref.content)
              .map((ref) => ref.path)
              .sort();
            if (added.length) changes.push(`adds ${added.join(", ")}`);
            if (replaced.length) changes.push(`replaces ${replaced.join(", ")}`);
            if (removedReferences.length) changes.push(`removes ${removedReferences.join(", ")}`);
            throw new Error(
              `Cloud Skill ${skill.name} (revision ${skill.revision}) differs from this folder: ${changes.join("; ")}. Pull it first to keep Cloud changes, or use --force to replace it.`,
            );
          }
          skill = (
            await readApi<{ skill: AiSkill }>(
              ctx,
              `/skills/${encodeURIComponent(skill.id)}`,
              jsonRequest("PUT", { ...fields, expectedRevision: skill.revision }),
            )
          ).skill;
          action = "updated";
          text = `Updated Cloud Skill ${skill.name} to revision ${skill.revision}.`;
          if (removedReferences.length) text += `\nRemoved from Cloud: ${removedReferences.join(", ")}.`;
        }
      } else {
        skill = (await readApi<{ skill: AiSkill }>(ctx, "/skills", jsonRequest("POST", fields))).skill;
        action = "created";
        text = `Created Cloud Skill ${skill.name}.`;
      }
      if (folder.skipped.length)
        text += `\nNot pushed: ${folder.skipped.join(", ")}. Cloud keeps SKILL.md and Markdown files directly in references/ with lowercase names (a-z, 0-9, ., _, -), and does not run scripts.`;
      printValue(
        ctx,
        {
          action,
          skill: {
            id: skill.id,
            name: skill.name,
            revision: skill.revision,
            permalink: cloudResourceUrl(ctx, { type: "core.ai.skill", id: skill.shortId }),
          },
          skipped: folder.skipped,
          removedReferences,
        },
        text,
      );
    },
  }),
  command("skills pull", {
    summary: "Copy a Cloud Skill to an Agent Skills folder",
    args: { skill: arg.required({ valueLabel: "name-or-id" }), dir: arg.optional({ valueLabel: "dir" }) },
    flags: { force: flag.boolean({ description: "Replace SKILL.md and its references; keep other files" }) },
    async run({ ctx, args, flags }) {
      const skill = await getSkill(ctx, args.skill);
      const dir = resolveLocalPath(args.dir ?? `.agents/skills/${skill.name}`, process.cwd());
      const files = [{ path: "SKILL.md", content: serializeAiSkillMarkdown(skill) }, ...validateAiSkillReferences(skill.references)];
      await writeSkillFiles(dir, files, flags.force);
      const target = relative(process.cwd(), dir) || ".";
      printValue(
        ctx,
        {
          skill: {
            id: skill.id,
            name: skill.name,
            revision: skill.revision,
            permalink: cloudResourceUrl(ctx, { type: "core.ai.skill", id: skill.shortId }),
          },
          dir: target,
          files: files.map((file) => file.path),
        },
        `Pulled ${skill.name} (revision ${skill.revision}, ${skill.references.length} reference${skill.references.length === 1 ? "" : "s"}) to ${target}.`,
      );
    },
  }),
] as const;
