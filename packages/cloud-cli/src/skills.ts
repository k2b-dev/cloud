/**
 * The `cloud-cli` agent skill on disk.
 *
 * `cld` writes one `cloud-cli` folder into every configured target
 * (`skills.targets` in the config, `~/.agents/skills` by default): the core
 * `SKILL.md` and references embedded in this `cld` release, plus
 * `references/<module>/<version>/` copied from the plugin store for every
 * module a profile has installed. `SKILL.md` carries a generated table from
 * profile to module, version, and reference folder. The folder is rebuilt as
 * a whole on every change, so versions no profile uses disappear.
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pluginStoreDirectory } from "./plugin-store";
import { pluginsDirectory } from "./plugins";
import { replaceDirectory } from "./release";
import { CORE_SKILL_FILES } from "./skill-source";

export const SKILL_NAME = "cloud-cli";
export const DEFAULT_SKILL_TARGET = "~/.agents/skills";
export const CLAUDE_SKILL_TARGET = "~/.claude/skills";

/** `skills` in the `cld` config. Absent means `cld` has not asked yet; an empty list means declined. */
export type SkillsConfig = { targets: string[] };

/** One installed module of one profile, as a row of the generated table. */
export type SkillModuleRow = { profile: string; name: string; version: string; digest: string };

const MODULES_START = "<!-- cld:modules -->";
const MODULES_END = "<!-- /cld:modules -->";

/** Expand a leading `~` and resolve the rest against the working directory. */
export const expandSkillTarget = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : resolve(path);

/** A target as the config stores it: `~/…` under the home directory, otherwise absolute. */
export const normalizeSkillTarget = (path: string): string => {
  const absolute = expandSkillTarget(path);
  const home = homedir();
  return absolute === home || absolute.startsWith(`${home}/`) ? `~${absolute.slice(home.length)}` : absolute;
};

/** Folder name of one module version; versions are opaque strings from the manifest. */
export const referenceFolder = (name: string, version: string): string => `references/${name}/${version.replace(/[^A-Za-z0-9._-]/g, "_")}/`;

export const renderModulesTable = (rows: readonly SkillModuleRow[]): string => {
  if (rows.length === 0) {
    return "No module is installed for any profile yet. `cld plugins install --all` installs the modules of the current profile's Cloud and fills this table.";
  }
  const sorted = [...rows].sort((left, right) => left.profile.localeCompare(right.profile) || left.name.localeCompare(right.name));
  return [
    "| Profile | Module | Version | Reference folder |",
    "| --- | --- | --- | --- |",
    ...sorted.map((row) => `| ${row.profile} | ${row.name} | ${row.version} | \`${referenceFolder(row.name, row.version)}\` |`),
  ].join("\n");
};

/** Replace the generated block of the core `SKILL.md` with the table for `rows`. */
export const renderSkill = (template: string, rows: readonly SkillModuleRow[]): string => {
  const start = template.indexOf(MODULES_START);
  const end = template.indexOf(MODULES_END);
  if (start < 0 || end < start) throw new Error("The cloud-cli SKILL.md has no cld:modules block.");
  return `${template.slice(0, start + MODULES_START.length)}\n${renderModulesTable(rows)}\n${template.slice(end)}`;
};

/**
 * Write the complete skill into `target`, replacing what is there. The
 * folder is staged next to its destination and swapped in one rename.
 */
export const writeSkillTarget = async (target: string, rows: readonly SkillModuleRow[], root = pluginsDirectory()): Promise<string> => {
  const destination = join(expandSkillTarget(target), SKILL_NAME);
  const staging = join(dirname(destination), `.${SKILL_NAME}.staging-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const [path, content] of Object.entries(CORE_SKILL_FILES)) {
      await mkdir(dirname(join(staging, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(staging, path), path === "SKILL.md" ? renderSkill(content, rows) : content);
    }
    const copied = new Set<string>();
    for (const row of rows) {
      const folder = referenceFolder(row.name, row.version);
      if (copied.has(folder)) continue;
      copied.add(folder);
      await cp(join(pluginStoreDirectory(root), row.digest, "references"), join(staging, folder), { recursive: true });
    }
    await replaceDirectory(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return destination;
};

/** Write every target; returns the written skill folders. */
export const syncSkillTargets = async (
  targets: readonly string[],
  rows: readonly SkillModuleRow[],
  root = pluginsDirectory(),
): Promise<string[]> => {
  const written: string[] = [];
  for (const target of targets) written.push(await writeSkillTarget(target, rows, root));
  return written;
};
