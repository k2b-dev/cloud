import { type SQL, sql, type TransactionSQL } from "bun";
import { z } from "zod";
import { APP_REGISTRY_TTL_MS } from "../_internal/registry";
import type { AppRegistryEntry } from "../contracts/registry";
import { logger } from "../services/logging";
import { toPgTextArray } from "../services/postgres";
import { type AppSkillDefinition, parseStoredAppSkill } from "./app-skills";
import { withAiShortIdForDb } from "./short-id";
import { AI_SKILL_CATALOG_MAX_CHARS, aiSkillCatalogChars } from "./skill-catalog";
import { appSkillStatus, contentHash } from "./skill-content";
import { serializeAiSkillMarkdown } from "./skill-format";
import {
  AiSkillInputError,
  AiSkillRevisionConflictError,
  createSkillAccess,
  getRow,
  listReferences,
  replaceSkillContent,
  rowContentHash,
  type SkillRow,
} from "./skills";

const log = logger("ai:app-skills");
type AppSkillRow = {
  key: string;
  app_id: string;
  app_name: string;
  name: string;
  skill_id: string | null;
  source: unknown;
  source_hash: string | null;
  applied_hash: string | null;
  manifest_hash: string | null;
  available: boolean;
  required_roles: string[] | null;
  conflict: "invalid" | "name_taken" | null;
};

const lock = (db: SQL) => db`SELECT pg_advisory_xact_lock(hashtext('cloud:ai:app-skills'))`;
const nameTaken = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "constraint" in error && error.constraint === "idx_ai_skills_name";

const install = async (source: AppSkillDefinition, db: SQL): Promise<SkillRow> => {
  const [row] = await withAiShortIdForDb(
    db,
    "idx_ai_skills_short_id",
    (attempt, shortId) => attempt<SkillRow[]>`
    INSERT INTO ai.skills(short_id, name, description, instructions, extra_frontmatter)
    VALUES (${shortId}, ${source.name}, ${source.description}, ${source.instructions},
      (${JSON.stringify(source.extraFrontmatter)}::text)::jsonb) RETURNING *`,
  );
  if (!row) throw new Error("Failed to install app skill.");
  for (const ref of source.references)
    await db`INSERT INTO ai.skill_references(skill_id, path, content) VALUES (${row.id}::uuid, ${ref.path}, ${ref.content})`;
  await createSkillAccess(row.id, { principal: { type: "authenticated" }, permission: "read" }, db);
  return row;
};
const sourceJson = (source: AppSkillDefinition): string =>
  JSON.stringify({
    name: source.name,
    description: source.description,
    instructions: source.instructions,
    extraFrontmatter: source.extraFrontmatter,
    references: source.references,
  });

/**
 * Brings one live app's Skills in line with its published catalog. Returns false while the advertised catalog is not
 * stored yet, so the caller retries on a later registry change.
 */
const reconcileApp = async (app: AppRegistryEntry, tx: TransactionSQL): Promise<boolean> => {
  if (!app.skills) {
    await tx`UPDATE ai.app_skills SET available=false, updated_at=now() WHERE app_id=${app.id} AND available`;
    return true;
  }
  const manifest = app.skills.manifestHash;
  const [catalog] = await tx<
    { skills: unknown }[]
  >`SELECT skills FROM ai.app_skill_catalogs WHERE app_id=${app.id} AND manifest_hash=${manifest}`;
  if (!catalog) return false; // Publication may still be in flight: keep the last known state.
  const roles = app.nav?.requiresRoles ?? null;
  const roleArray = roles === null ? null : toPgTextArray(roles);
  const [state] = await tx<{ current: boolean }[]>`SELECT
    EXISTS(SELECT 1 FROM ai.app_skills WHERE app_id=${app.id}) AND
    NOT EXISTS(SELECT 1 FROM ai.app_skills WHERE app_id=${app.id} AND (
      manifest_hash IS DISTINCT FROM ${manifest} OR NOT available OR app_name IS DISTINCT FROM ${app.name}
      OR required_roles IS DISTINCT FROM ${roleArray}::text[]
    )) AS current`;
  if (state?.current) return true;
  const entries = z
    .array(z.unknown())
    .max(Math.floor((AI_SKILL_CATALOG_MAX_CHARS + 1) / "- a: b\n".length))
    .parse(catalog.skills);
  const names = new Set<string>();
  let catalogChars = 0;
  for (const [index, input] of entries.entries()) {
    const name = input && typeof input === "object" && "name" in input && typeof input.name === "string" ? input.name : `invalid-${index}`;
    const key = `app:${app.id}/${name}`;
    let source: AppSkillDefinition;
    try {
      source = parseStoredAppSkill(input);
      if (names.has(name)) throw new Error(`Skill "${name}" is duplicated.`);
      catalogChars += aiSkillCatalogChars([source]) + (names.size ? 1 : 0);
      if (catalogChars > AI_SKILL_CATALOG_MAX_CHARS) throw new Error("App skill catalog exceeds the Assistant catalog budget.");
    } catch (error) {
      names.add(name);
      await tx`INSERT INTO ai.app_skills(key, app_id, app_name, name, manifest_hash, available, required_roles, conflict)
        VALUES (${key}, ${app.id}, ${app.name}, ${name}, ${manifest}, true, ${roleArray}::text[], 'invalid')
        ON CONFLICT(key) DO UPDATE SET app_name=EXCLUDED.app_name, manifest_hash=EXCLUDED.manifest_hash,
          available=true, required_roles=EXCLUDED.required_roles, conflict='invalid', updated_at=now()`;
      log.warn("Invalid app skill skipped", { appId: app.id, name, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    names.add(name);
    const [managed] = await tx<AppSkillRow[]>`INSERT INTO ai.app_skills
      (key, app_id, app_name, name, source, source_hash, manifest_hash, available, required_roles)
      VALUES (${key}, ${app.id}, ${app.name}, ${name}, (${sourceJson(source)}::text)::jsonb,
        ${source.hash}, ${manifest}, true, ${roleArray}::text[])
      ON CONFLICT(key) DO UPDATE SET app_name=EXCLUDED.app_name, source=EXCLUDED.source, source_hash=EXCLUDED.source_hash,
        manifest_hash=EXCLUDED.manifest_hash, available=true, required_roles=EXCLUDED.required_roles,
        conflict=CASE WHEN ai.app_skills.skill_id IS NULL THEN ai.app_skills.conflict ELSE NULL END, updated_at=now()
      RETURNING *`;
    if (!managed) throw new Error("Failed to read app skill association.");
    if (managed.skill_id) {
      const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id=${managed.skill_id}::uuid FOR UPDATE`;
      if (!row) continue; // A durable admin deletion, even when the app's manifest changes.
      const hash = await rowContentHash(row, tx);
      if (hash === source.hash) {
        if (managed.applied_hash !== source.hash) await tx`UPDATE ai.app_skills SET applied_hash=${source.hash} WHERE key=${key}`;
      } else if (hash === managed.applied_hash) {
        try {
          await tx.savepoint(async (attempt) => {
            await replaceSkillContent(row, source, attempt);
            await attempt`UPDATE ai.app_skills SET applied_hash=${source.hash} WHERE key=${key}`;
          });
        } catch (error) {
          if (!nameTaken(error)) throw error;
          await tx`UPDATE ai.app_skills SET conflict='name_taken' WHERE key=${key}`;
        }
      }
      continue;
    }
    try {
      await tx.savepoint(async (attempt) => {
        const row = await install(source, attempt);
        await attempt`UPDATE ai.app_skills SET skill_id=${row.id}::uuid, applied_hash=${source.hash}, conflict=NULL WHERE key=${key}`;
      });
    } catch (error) {
      if (!nameTaken(error)) throw error;
      await tx`UPDATE ai.app_skills SET conflict='name_taken' WHERE key=${key}`;
    }
  }
  await tx`UPDATE ai.app_skills SET available=false, updated_at=now()
    WHERE app_id=${app.id} AND available AND NOT(name=ANY(${toPgTextArray([...names])}::text[]))`;
  return true;
};

/**
 * Core's sync from the live registry into `ai.skills`. One app's broken catalog never blocks another app. Returns
 * whether every advertised catalog was applied.
 */
export const reconcileAppSkills = async (apps: readonly AppRegistryEntry[], db: SQL = sql): Promise<boolean> => {
  const liveIds = toPgTextArray(apps.map((app) => app.id));
  await db.begin(async (tx) => {
    await lock(tx);
    await tx`UPDATE ai.app_skills SET available=false, updated_at=now()
      WHERE available AND NOT (app_id=ANY(${liveIds}::text[]))`;
    await tx`DELETE FROM ai.app_skill_catalogs WHERE last_seen_at < now() - ${APP_REGISTRY_TTL_MS * 2} * interval '1 millisecond'`;
  });
  let complete = true;
  for (const app of apps) {
    try {
      const applied = await db.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = '10s'`.simple();
        await lock(tx);
        return reconcileApp(app, tx);
      });
      if (!applied) complete = false;
    } catch (error) {
      complete = false;
      log.error("App skill reconciliation failed", { appId: app.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return complete;
};

/** An app Skill Cloud does not offer because an administrator deleted it or it could not be installed. */
export type AiAppSkillIssue = {
  appId: string;
  appName: string;
  name: string;
  state: "deleted" | "name_taken" | "invalid";
  available: boolean;
};

export const appSkillIssues = async (): Promise<AiAppSkillIssue[]> => sql`SELECT app.app_id AS "appId", app.app_name AS "appName", app.name,
  COALESCE(app.conflict, 'deleted') AS state, app.available
  FROM ai.app_skills app LEFT JOIN ai.skills skill ON skill.id=app.skill_id
  WHERE (app.skill_id IS NOT NULL AND skill.id IS NULL) OR app.conflict IS NOT NULL ORDER BY app.app_id, app.name LIMIT 500`;

export const appSkillVersion = async (skillId: string) =>
  sql.begin(async (tx) => {
    // Source association before Skill, matching reconciliation/reset lock order.
    const [app] = await tx<AppSkillRow[]>`SELECT * FROM ai.app_skills WHERE skill_id=${skillId}::uuid FOR SHARE`;
    const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id=${skillId}::uuid FOR SHARE`;
    if (!row) return null;
    const fields = {
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      extraFrontmatter: z.record(z.string(), z.unknown()).parse(row.extra_frontmatter),
      references: await listReferences(skillId, tx),
    };
    const source = app?.source ? parseStoredAppSkill(app.source) : null;
    return {
      current: { markdown: serializeAiSkillMarkdown(fields), references: fields.references },
      app: source ? { markdown: serializeAiSkillMarkdown(source), references: source.references } : null,
      /** Pass back to reset, so a release published after the review is not applied unseen. */
      appVersion: source ? source.hash : null,
      status: app ? appSkillStatus(contentHash(fields), app.source_hash, app.applied_hash) : null,
    };
  });

export const resetAppSkill = async (skillId: string, expectedRevision: number, expectedAppVersion: string): Promise<boolean> =>
  sql.begin(async (tx) => {
    await lock(tx);
    const [app] = await tx<AppSkillRow[]>`SELECT * FROM ai.app_skills WHERE skill_id=${skillId}::uuid FOR UPDATE`;
    const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id=${skillId}::uuid FOR UPDATE`;
    if (!row) return false;
    if (Number(row.revision) !== expectedRevision) throw new AiSkillRevisionConflictError();
    if (!app?.source || !app.source_hash) throw new AiSkillInputError("No app source is available for this Skill.");
    if (app.source_hash !== expectedAppVersion)
      throw new AiSkillRevisionConflictError(
        "The app shipped a different version since you compared it. Compare it again before resetting.",
      );
    const source = parseStoredAppSkill(app.source);
    try {
      await tx.savepoint((attempt) => replaceSkillContent(row, source, attempt));
    } catch (error) {
      if (nameTaken(error)) throw new AiSkillRevisionConflictError("A Skill with this name already exists.");
      throw error;
    }
    await tx`UPDATE ai.app_skills SET applied_hash=${source.hash}, conflict=NULL, updated_at=now() WHERE key=${app.key}`;
    return true;
  });

export const restoreAppSkill = async (appId: string, name: string): Promise<boolean> =>
  sql.begin(async (tx) => {
    await lock(tx);
    const [app] = await tx<AppSkillRow[]>`SELECT * FROM ai.app_skills WHERE app_id=${appId} AND name=${name} FOR UPDATE`;
    if (!app) return false;
    if (!app.source) throw new AiSkillInputError("No app source is available for this Skill.");
    if (app.skill_id && (await getRow(app.skill_id, tx))) throw new AiSkillRevisionConflictError("This app Skill is already installed.");
    const source = parseStoredAppSkill(app.source);
    let row: SkillRow;
    try {
      row = await tx.savepoint((attempt) => install(source, attempt));
    } catch (error) {
      if (nameTaken(error)) throw new AiSkillRevisionConflictError("A Skill with this name already exists.");
      throw error;
    }
    await tx`UPDATE ai.app_skills SET skill_id=${row.id}::uuid, applied_hash=${source.hash}, conflict=NULL, updated_at=now() WHERE key=${app.key}`;
    return true;
  });

/**
 * Links the Skill that already holds an app Skill's name to that app Skill. Its content stays as an administrator
 * customization until an administrator resets it; grants, short ID and personal settings stay unchanged.
 */
export const adoptAppSkill = async (appId: string, name: string): Promise<boolean> =>
  sql.begin(async (tx) => {
    await lock(tx);
    const [app] = await tx<AppSkillRow[]>`SELECT * FROM ai.app_skills WHERE app_id=${appId} AND name=${name} FOR UPDATE`;
    if (!app) return false;
    if (!app.source_hash) throw new AiSkillInputError("No app source is available for this Skill.");
    if (app.skill_id && (await getRow(app.skill_id, tx))) throw new AiSkillRevisionConflictError("This app Skill is already installed.");
    const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE name=${name} FOR UPDATE`;
    if (!row) throw new AiSkillInputError("No Skill uses this name. Install the app Skill instead.");
    const [linked] = await tx`SELECT 1 FROM ai.app_skills WHERE skill_id=${row.id}::uuid`;
    if (linked) throw new AiSkillRevisionConflictError("This Skill already belongs to another app Skill.");
    await tx`UPDATE ai.app_skills SET skill_id=${row.id}::uuid, applied_hash=${app.source_hash}, conflict=NULL, updated_at=now()
      WHERE key=${app.key}`;
    return true;
  });

/** Platform-admin operations on app Skills. Callers enforce platform-admin authorization. */
export const aiAppSkills = {
  appSkillIssues,
  appVersion: appSkillVersion,
  reset: resetAppSkill,
  restore: restoreAppSkill,
  adopt: adoptAppSkill,
};
