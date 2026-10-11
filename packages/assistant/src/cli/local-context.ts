import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { AiLocalContext } from "@k2b/cloud/ai";
import {
  AI_LOCAL_INSTRUCTIONS_MAX_BYTES,
  AI_LOCAL_SKILLS_MAX_ITEMS,
  AI_SKILL_DESCRIPTION_MAX_CHARS,
  AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS,
  AI_SKILL_INSTRUCTIONS_MAX_CHARS,
  AI_SKILL_NAME_MAX_CHARS,
  splitAiSkillMarkdown,
} from "@k2b/cloud/ai/browser";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { classifyLocalPath, isProtectedLocalPath } from "./local-paths";

export type LocalSkill = {
  name: string;
  description: string;
  scope: "project" | "global";
  directory: string;
  path: string;
  manualOnly: boolean;
};
export type LocalContext = {
  root: string;
  instructions: AiLocalContext["instructions"];
  instructionPaths: string[];
  shortened: boolean;
  skills: LocalSkill[];
  hidden: Array<{ name: string; scope: "project" | "global"; reason: string }>;
  problems: Array<{ path: string; error: string }>;
  hasProjectContext: boolean;
  trusted: boolean;
};

// Four bytes per character cover UTF-8; the allowance covers delimiters and field labels.
const maxSkillBytes =
  4 * (AI_SKILL_NAME_MAX_CHARS + AI_SKILL_DESCRIPTION_MAX_CHARS + AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS + AI_SKILL_INSTRUCTIONS_MAX_CHARS) +
  128;
const skillSizeError = "SKILL.md is larger than a Skill can be; not loaded";

const entries = async (directory: string) => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(String(error.code))) return [];
    throw error;
  }
};

/** Discovery keeps project context separate until the session's trust decision. */
export const discoverLocalContext = async (workspace: string, home = homedir(), includeProject = true): Promise<LocalContext> => {
  const folders = [await realpath(workspace)];
  let root = folders[0]!;
  // A .git file points to a worktree; a .git folder counts only with HEAD, as an empty leftover is no repository.
  const isGitRoot = async (folder: string) =>
    (await entries(folder)).some((entry) => entry.name === ".git" && entry.isFile()) ||
    (await Bun.file(join(folder, ".git/HEAD")).exists());
  while (!(await isGitRoot(root))) {
    const parent = dirname(root);
    if (parent === root) {
      folders.splice(1);
      root = folders[0]!;
      break;
    }
    folders.push(parent);
    root = parent;
  }
  const context: LocalContext = {
    root,
    instructions: [],
    instructionPaths: [],
    shortened: false,
    skills: [],
    hidden: [],
    problems: [],
    hasProjectContext: false,
    trusted: false,
  };
  for (const folder of folders) {
    if (!(await entries(folder)).some((entry) => entry.name === "AGENTS.md")) continue;
    const path = join(folder, "AGENTS.md");
    // A dangling link has no target to load; it is reported like a link that leaves the project.
    const target = await realpath(path).catch(() => undefined);
    const child = target === undefined ? ".." : relative(context.root, target);
    if (
      target === undefined ||
      child === ".." ||
      child.startsWith(`..${sep}`) ||
      child.startsWith(sep) ||
      isProtectedLocalPath(path) ||
      isProtectedLocalPath(target) ||
      classifyLocalPath(path, { workspace, home }).access === "blocked"
    ) {
      context.problems.push({ path, error: "AGENTS.md points outside the project or to a protected file; not loaded" });
      continue;
    }
    if (!(await stat(path)).isFile()) continue;
    context.instructionPaths.push(path);
  }
  context.hasProjectContext = context.instructionPaths.length > 0;
  let remaining = AI_LOCAL_INSTRUCTIONS_MAX_BYTES;
  for (const path of context.instructionPaths) {
    if (remaining <= 0) {
      context.shortened = true;
      break;
    }
    // Decoding never shrinks text (an invalid byte becomes a 3-byte U+FFFD), so one byte past the budget is enough to read.
    let content = await Bun.file(path)
      .slice(0, remaining + 1)
      .text();
    if (Buffer.byteLength(content) > remaining) {
      const suffix = "\n[shortened by cld: 32 KiB limit]";
      if (remaining < Buffer.byteLength(suffix)) {
        context.shortened = true;
        break;
      }
      const bytes = Buffer.from(content).subarray(0, remaining - Buffer.byteLength(suffix));
      // Do not split a UTF-8 character at the budget boundary.
      content = new TextDecoder().decode(bytes, { stream: true }) + suffix;
      context.shortened = true;
    }
    context.instructions.unshift({ path, content });
    remaining -= Buffer.byteLength(content);
    if (context.shortened) break;
  }
  context.instructionPaths.reverse();
  const seenDirectories = new Set<string>();
  const names = new Map<string, LocalSkill>();
  // In the home folder the project Skill folder is the global one; it stays global and never asks for trust.
  const globalSkills = join(home, ".agents/skills");
  for (const [directory, scope] of [
    ...(includeProject
      ? folders
          .map((folder): [string, "project"] => [join(folder, ".agents/skills"), "project"])
          .filter(([directory]) => directory !== globalSkills)
      : []),
    [globalSkills, "global"] as const,
  ]) {
    for (const entry of (await entries(directory)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name, "SKILL.md");
      try {
        if (!(await entries(join(directory, entry.name))).some((file) => file.name === "SKILL.md")) continue;
        if (scope === "project") context.hasProjectContext = true;
        if (classifyLocalPath(path, { workspace, home }).access === "blocked") continue;
        const skillDirectory = await realpath(join(directory, entry.name));
        if (seenDirectories.has(skillDirectory)) continue;
        seenDirectories.add(skillDirectory);
        if ((await stat(path)).size > maxSkillBytes) {
          context.problems.push({ path, error: skillSizeError });
          continue;
        }
        const { fields } = splitAiSkillMarkdown(await Bun.file(path).text());
        if (fields.name !== undefined && typeof fields.name !== "string") throw new Error("invalid Skill name");
        const name = typeof fields.name === "string" ? fields.name.trim() : entry.name;
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error("invalid Skill name");
        if (typeof fields.description !== "string" || !fields.description.trim()) throw new Error("missing or empty description");
        let description = fields.description.trim();
        if (name !== entry.name) context.problems.push({ path, error: `name ${name} differs from folder ${entry.name}` });
        if (description.length > 1024) {
          description = description.slice(0, 1024);
          context.problems.push({ path, error: "description shortened to 1024 characters" });
        }
        const skill: LocalSkill = {
          name,
          description,
          scope,
          directory: skillDirectory,
          path,
          manualOnly: fields["disable-model-invocation"] === true,
        };
        if (name === "cloud-cli") context.hidden.push({ name, scope, reason: "cld reaches Cloud through its own tools" });
        else if (names.has(name)) context.hidden.push({ name, scope, reason: `hidden by the ${names.get(name)!.scope} Skill` });
        else {
          names.set(name, skill);
          context.skills.push(skill);
        }
      } catch (error) {
        context.problems.push({ path, error: `invalid frontmatter: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
  return context;
};

export const localSkillCatalog = (context: LocalContext): AiLocalContext["skills"] =>
  context.skills
    .slice(0, AI_LOCAL_SKILLS_MAX_ITEMS)
    .map(({ name, description, scope, manualOnly }) => ({ name, description, scope, ...(manualOnly ? { manualOnly: true } : {}) }));

/** Trust belongs to the profile on this device; a session decision survives rereads. */
export const createLocalContextReader = (input: {
  ctx: Pick<CloudCliContext, "getDefault" | "setDefault">;
  workspace: string;
  home?: string;
  askTrust: (context: LocalContext) => Promise<"folder" | "session" | undefined>;
}) => {
  let decision: boolean | undefined;
  return async (): Promise<LocalContext> => {
    const context = await discoverLocalContext(input.workspace, input.home);
    if (context.hasProjectContext && decision === undefined) {
      let trustedFolders: string[] = [];
      try {
        const value: unknown = JSON.parse((await input.ctx.getDefault("assistant.trustedFolders")) ?? "[]");
        if (Array.isArray(value) && value.every((path): path is string => typeof path === "string")) trustedFolders = value;
      } catch {
        /* A broken saved value grants no trust. */
      }
      if (trustedFolders.includes(context.root)) decision = true;
      else {
        const answer = await input.askTrust(context);
        decision = answer !== undefined;
        if (answer === "folder") await input.ctx.setDefault("assistant.trustedFolders", JSON.stringify([...trustedFolders, context.root]));
      }
    }
    context.trusted = decision === true;
    if (!context.trusted) {
      context.instructions = [];
      const global = await discoverLocalContext(input.workspace, input.home, false);
      context.skills = global.skills;
      context.hidden = global.hidden;
      context.problems = global.problems;
    }
    let count = 0;
    for (const skill of context.skills) {
      if (++count > AI_LOCAL_SKILLS_MAX_ITEMS) context.problems.push({ path: skill.path, error: "more than 64 Skills; not listed" });
    }
    return context;
  };
};

export const readLocalSkill = async (skill: LocalSkill, workspace = process.cwd()): Promise<AiLocalContext["selectedSkills"][number]> => {
  if (classifyLocalPath(skill.path, { workspace }).access === "blocked")
    throw new Error("cld's configuration is never available to the assistant.");
  if ((await stat(skill.path)).size > maxSkillBytes) throw new Error(skillSizeError);
  const { body } = splitAiSkillMarkdown(await Bun.file(skill.path).text());
  if (!body.trim()) throw new Error(`Skill ${skill.name} has no instructions.`);
  if (body.length > 100_000) throw new Error("Skill instructions exceed 100000 characters.");
  return { name: skill.name, directory: await realpath(skill.directory), instructions: body };
};
