import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AiLocalContext } from "@k2b/cloud/ai";
import { AI_LOCAL_INSTRUCTIONS_MAX_BYTES, AI_LOCAL_SKILLS_MAX_ITEMS, splitAiSkillMarkdown } from "@k2b/cloud/ai/browser";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { classifyLocalPath } from "./local-paths";

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

const entries = async (directory: string) => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
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
    if (classifyLocalPath(path, { workspace, home }).access === "blocked") continue;
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
    const file = Bun.file(path);
    const size = file.size;
    let content: string;
    if (size > remaining) {
      const suffix = "\n[shortened by cld: 32 KiB limit]";
      if (remaining < Buffer.byteLength(suffix)) {
        context.shortened = true;
        break;
      }
      const bytes = Buffer.from(await file.slice(0, remaining - Buffer.byteLength(suffix)).arrayBuffer());
      // Do not split a UTF-8 character at the budget boundary.
      content = bytes.toString("utf8").replace(/\uFFFD$/, "") + suffix;
      context.shortened = true;
    } else content = await file.text();
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
    .filter((skill) => !skill.manualOnly)
    .slice(0, AI_LOCAL_SKILLS_MAX_ITEMS)
    .map(({ name, description, scope }) => ({ name, description, scope }));

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
      if (!skill.manualOnly && ++count > AI_LOCAL_SKILLS_MAX_ITEMS)
        context.problems.push({ path: skill.path, error: "more than 64 Skills; not listed" });
    }
    return context;
  };
};

export const readLocalSkill = async (skill: LocalSkill, workspace = process.cwd()): Promise<AiLocalContext["selectedSkills"][number]> => {
  if (classifyLocalPath(skill.path, { workspace }).access === "blocked")
    throw new Error("cld's configuration is never available to the assistant.");
  const { body } = splitAiSkillMarkdown(await Bun.file(skill.path).text());
  if (!body.trim()) throw new Error(`Skill ${skill.name} has no instructions.`);
  if (body.length > 100_000) throw new Error("Skill instructions exceed 100000 characters.");
  return { name: skill.name, directory: await realpath(skill.directory), instructions: body };
};
