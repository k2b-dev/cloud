import { type SQL, type SQLQuery, sql } from "bun";
import type { AccessSubject } from "../server";
import {
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  hasPermission,
  type PermissionLevel,
  type Principal,
} from "../server/services/access";
import { toPgUuidArray } from "../services/postgres";
import { mountAiSkillFilePath } from "./file-mount";
import { withAiShortIdForDb } from "./short-id";
import {
  type AiSkillExtraFrontmatter,
  type AiSkillReferenceInput,
  serializeAiSkillMarkdown,
  validateAiSkillDescription,
  validateAiSkillExtraFrontmatter,
  validateAiSkillInstructions,
  validateAiSkillName,
  validateAiSkillReferences,
} from "./skill-format";
import type { AiSkillFileToolContent, AiSkillFileToolStat } from "./types";

export type AiSkillPermission = Exclude<PermissionLevel, "none">;

export type AiSkillReference = AiSkillReferenceInput;

export type AiSkillSummary = {
  id: string;
  shortId: string;
  name: string;
  description: string;
  permission: AiSkillPermission;
  enabled: boolean;
  revision: number;
  referenceCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AiSkill = AiSkillSummary & {
  instructions: string;
  extraFrontmatter: AiSkillExtraFrontmatter;
  references: AiSkillReference[];
};

export type AiSkillAccess = {
  id: string;
  shortId: string;
  principal: Principal;
  permission: AiSkillPermission;
  displayName?: string;
  createdAt: string;
};

export type AiSkillAdminListItem = {
  id: string;
  shortId: string;
  name: string;
  description: string;
  referenceCount: number;
  accessCount: number;
  adminCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AiSkillAdminSummary = {
  total: number;
  unmanaged: number;
  totalAccess: number;
};

export type AiLoadedSkillSnapshot = {
  name: string;
  description: string;
  revision: number;
  instructions: string;
  files: { path: string; content: string }[];
  loadedAt: string;
};

type SkillRow = {
  id: string;
  short_id: string;
  managed_key: string | null;
  name: string;
  description: string;
  instructions: string;
  extra_frontmatter: AiSkillExtraFrontmatter | string;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type SkillAccessRow = {
  short_id: string;
  user_id: string | null;
  group_id: string | null;
  service_account_id: string | null;
  authenticated_only: boolean;
  permission: AiSkillPermission;
  created_at: Date | string;
  display_name: string | null;
};

type SkillSummaryRow = SkillRow & {
  permission: AiSkillPermission;
  reference_count: number;
  enabled: boolean;
};

type AdminSkillRow = SkillRow & {
  reference_count: number;
  access_count: number;
  admin_count: number;
};

type SnapshotRow = {
  skill_name: string;
  description: string;
  revision: number;
  instructions: string;
  files: { path: string; content: string }[] | string;
  loaded_at: Date | string;
};

export class AiSkillLastAdminError extends Error {
  constructor() {
    super("A skill must keep at least one admin access entry.");
    this.name = "AiSkillLastAdminError";
  }
}

export class AiSkillRevisionConflictError extends Error {
  constructor() {
    super("This skill changed after it was opened. Reload it before saving.");
    this.name = "AiSkillRevisionConflictError";
  }
}

export class AiSkillInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiSkillInputError";
  }
}

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

const jsonObject = (value: AiSkillExtraFrontmatter | string): AiSkillExtraFrontmatter =>
  typeof value === "string" ? (JSON.parse(value) as AiSkillExtraFrontmatter) : value;

const snapshotFiles = (value: SnapshotRow["files"]): { path: string; content: string }[] =>
  typeof value === "string" ? (JSON.parse(value) as { path: string; content: string }[]) : value;

const principalForSubject = (subject: AccessSubject): Principal =>
  subject.type === "user"
    ? { type: "user", userId: subject.userId }
    : { type: "service_account", serviceAccountId: subject.serviceAccountId };

const accessMatch = (subject: AccessSubject | null): SQLQuery =>
  buildAccessPrincipalCondition({
    subject,
    columns: {
      userId: sql`access.user_id`,
      groupId: sql`access.group_id`,
      serviceAccountId: sql`access.service_account_id`,
      authenticatedOnly: sql`access.authenticated_only`,
    },
  });

const getRow = async (skillId: string, db: SQL = sql): Promise<SkillRow | null> =>
  (await db<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid`)[0] ?? null;

const getRowByShortId = async (shortId: string, db: SQL = sql): Promise<SkillRow | null> =>
  (await db<SkillRow[]>`SELECT * FROM ai.skills WHERE short_id = ${shortId}`)[0] ?? null;

const getRowByName = async (name: string, db: SQL = sql): Promise<SkillRow | null> =>
  (await db<SkillRow[]>`SELECT * FROM ai.skills WHERE name = ${name}`)[0] ?? null;

const permissionFor = async (skillId: string, subject: AccessSubject | null, db: SQL = sql): Promise<AiSkillPermission | "none"> => {
  const match = accessMatch(subject);
  const rows = await db<{ permission: AiSkillPermission }[]>`
    SELECT access.permission
    FROM ai.skill_access skill_access
    JOIN auth.access access ON access.id = skill_access.access_id
    WHERE skill_access.skill_id = ${skillId}::uuid AND ${match}
    ORDER BY CASE access.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END DESC
    LIMIT 1
  `;
  return rows[0]?.permission ?? "none";
};

const enabledFor = async (skillId: string, subject: AccessSubject | null, db: SQL = sql): Promise<boolean> => {
  if (subject?.type !== "user") return true;
  const [disabled] = await db<{ disabled: boolean }[]>`
    SELECT true AS disabled
    FROM ai.skill_user_disabled
    WHERE skill_id = ${skillId}::uuid AND user_id = ${subject.userId}::uuid
  `;
  return !disabled;
};

const listReferences = async (skillId: string, db: SQL = sql): Promise<AiSkillReference[]> =>
  db<AiSkillReference[]>`
    SELECT path, content FROM ai.skill_references
    WHERE skill_id = ${skillId}::uuid
    ORDER BY path
  `;

const toSkill = async (row: SkillRow, subject: AccessSubject | null, db: SQL = sql): Promise<AiSkill | null> => {
  const permission = await permissionFor(row.id, subject, db);
  if (permission === "none") return null;
  const references = await listReferences(row.id, db);
  return {
    id: row.id,
    shortId: row.short_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    extraFrontmatter: jsonObject(row.extra_frontmatter),
    references,
    referenceCount: references.length,
    permission,
    enabled: await enabledFor(row.id, subject, db),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
};

const requireSkill = async (
  row: SkillRow | null,
  subject: AccessSubject | null,
  required: AiSkillPermission = "read",
  db: SQL = sql,
): Promise<AiSkill | null> => {
  if (!row) return null;
  const skill = await toSkill(row, subject, db);
  return skill && hasPermission(skill.permission, required) ? skill : null;
};

const listSkillAccess = async (skillId: string, db: SQL = sql): Promise<AiSkillAccess[]> => {
  const rows = await db<SkillAccessRow[]>`
    SELECT skill_access.short_id, access.user_id, access.group_id, access.service_account_id, access.authenticated_only,
           access.permission, access.created_at,
           COALESCE(users.display_name, groups.name, service_accounts.name,
             CASE WHEN access.authenticated_only THEN 'All authenticated users' ELSE 'Public' END) AS display_name
    FROM ai.skill_access skill_access
    JOIN auth.access access ON access.id = skill_access.access_id
    LEFT JOIN auth.users users ON users.id = access.user_id
    LEFT JOIN auth.groups groups ON groups.id = access.group_id
    LEFT JOIN auth.service_accounts service_accounts ON service_accounts.id = access.service_account_id
    WHERE skill_access.skill_id = ${skillId}::uuid
    ORDER BY access.created_at, access.id
  `;
  return rows.map((row) => ({
    id: row.short_id,
    shortId: row.short_id,
    principal: row.user_id
      ? { type: "user", userId: row.user_id }
      : row.group_id
        ? { type: "group", groupId: row.group_id }
        : row.service_account_id
          ? { type: "service_account", serviceAccountId: row.service_account_id }
          : row.authenticated_only
            ? { type: "authenticated" }
            : { type: "public" },
    permission: row.permission,
    displayName: row.display_name ?? undefined,
    createdAt: iso(row.created_at),
  }));
};

const createSkillAccess = async (
  skillId: string,
  input: { principal: Principal; permission: AiSkillPermission },
  db: SQL,
): Promise<AiSkillAccess> => {
  const created = await createAccess(input, db);
  if (!created.ok) throw new Error(created.error.message);
  let shortId = "";
  try {
    await withAiShortIdForDb(db, "idx_ai_skill_access_short_id", (attempt, candidate) => {
      shortId = candidate;
      return attempt`
        INSERT INTO ai.skill_access (skill_id, access_id, short_id)
        VALUES (${skillId}::uuid, ${created.data.id}::uuid, ${candidate})
      `;
    });
  } catch (error) {
    await deleteAccess({ id: created.data.id }, db);
    throw error;
  }
  const entry = (await listSkillAccess(skillId, db)).find((item) => item.shortId === shortId);
  if (!entry) throw new Error("Failed to read the created skill access entry.");
  return entry;
};

const updateSkillAccess = async (skillId: string, accessId: string, permission: AiSkillPermission, db: SQL): Promise<boolean> => {
  const [bound] = await db<{ id: string; permission: AiSkillPermission }[]>`
    SELECT access.id, access.permission
    FROM ai.skill_access skill_access
    JOIN auth.access access ON access.id = skill_access.access_id
    WHERE skill_access.skill_id = ${skillId}::uuid AND skill_access.short_id = ${accessId}
  `;
  if (!bound) return false;
  if (bound.permission === "admin" && permission !== "admin") {
    const [admins] = await db<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ai.skill_access skill_access
      JOIN auth.access access ON access.id = skill_access.access_id
      WHERE skill_access.skill_id = ${skillId}::uuid AND access.permission = 'admin'
    `;
    if ((admins?.count ?? 0) <= 1) throw new AiSkillLastAdminError();
  }
  return (await db`UPDATE auth.access SET permission = ${permission}::auth.permission_level WHERE id = ${bound.id}::uuid`).count === 1;
};

const revokeSkillAccess = async (skillId: string, accessId: string, db: SQL): Promise<boolean> => {
  const [bound] = await db<{ access_id: string; permission: AiSkillPermission }[]>`
    SELECT skill_access.access_id, access.permission
    FROM ai.skill_access skill_access
    JOIN auth.access access ON access.id = skill_access.access_id
    WHERE skill_access.skill_id = ${skillId}::uuid AND skill_access.short_id = ${accessId}
  `;
  if (!bound) return false;
  if (bound.permission === "admin") {
    const [admins] = await db<{ count: number }[]>`
      SELECT count(*)::int AS count FROM ai.skill_access skill_access
      JOIN auth.access access ON access.id = skill_access.access_id
      WHERE skill_access.skill_id = ${skillId}::uuid AND access.permission = 'admin'
    `;
    if ((admins?.count ?? 0) <= 1) throw new AiSkillLastAdminError();
  }
  const deleted = await deleteAccess({ id: bound.access_id }, db);
  if (!deleted.ok) throw new Error(deleted.error.message);
  return true;
};

const validatedFields = (input: {
  name: string;
  description: string;
  instructions: string;
  extraFrontmatter?: AiSkillExtraFrontmatter;
  references?: readonly AiSkillReferenceInput[];
}) => {
  try {
    return {
      name: validateAiSkillName(input.name),
      description: validateAiSkillDescription(input.description),
      instructions: validateAiSkillInstructions(input.instructions),
      extraFrontmatter: validateAiSkillExtraFrontmatter(input.extraFrontmatter),
      references: validateAiSkillReferences(input.references ?? []),
    };
  } catch (error) {
    if (error instanceof Error) throw new AiSkillInputError(error.message);
    throw error;
  }
};

const sameReferences = (left: readonly AiSkillReference[], right: readonly AiSkillReference[]): boolean =>
  left.length === right.length &&
  left.every((reference, index) => reference.path === right[index]?.path && reference.content === right[index]?.content);

const skillSearchPattern = (search?: string): string | null => {
  const value = search?.trim().toLowerCase();
  return value ? `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
};

const toAdminSkill = (row: AdminSkillRow): AiSkillAdminListItem => ({
  id: row.id,
  shortId: row.short_id,
  name: row.name,
  description: row.description,
  referenceCount: Number(row.reference_count),
  accessCount: Number(row.access_count),
  adminCount: Number(row.admin_count),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const skillSnapshotFiles = (skill: AiSkill): { path: string; content: string }[] => [
  {
    path: `${skill.name}/SKILL.md`,
    content: serializeAiSkillMarkdown(skill),
  },
  ...skill.references.map((reference) => ({ path: `${skill.name}/${reference.path}`, content: reference.content })),
];

export const aiSkills = {
  async seedOnce(input: {
    key: string;
    name: string;
    description: string;
    instructions: string;
    extraFrontmatter?: AiSkillExtraFrontmatter;
    references?: readonly AiSkillReferenceInput[];
  }): Promise<void> {
    const key = input.key.trim();
    if (!key) throw new AiSkillInputError("Skill seed key is required.");
    const fields = validatedFields(input);
    await sql.begin(async (tx) => {
      const [claimed] = await tx<{ key: string }[]>`
        INSERT INTO ai.skill_seeds (key) VALUES (${key})
        ON CONFLICT (key) DO NOTHING
        RETURNING key
      `;
      if (!claimed) return;

      let [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE managed_key = ${key} FOR UPDATE`;
      if (!row) {
        const [conflict] = await tx<{ id: string }[]>`SELECT id FROM ai.skills WHERE name = ${fields.name}`;
        if (conflict) return;
        const rows = await withAiShortIdForDb(
          tx,
          "idx_ai_skills_short_id",
          (attempt, shortId) => attempt<SkillRow[]>`
            INSERT INTO ai.skills (short_id, name, description, instructions, extra_frontmatter)
            VALUES (
              ${shortId}, ${fields.name}, ${fields.description}, ${fields.instructions},
              (${JSON.stringify(fields.extraFrontmatter)}::text)::jsonb
            )
            RETURNING *
          `,
        );
        row = rows[0]!;
      } else {
        const references = await listReferences(row.id, tx);
        const changed =
          row.name !== fields.name ||
          row.description !== fields.description ||
          row.instructions !== fields.instructions ||
          JSON.stringify(jsonObject(row.extra_frontmatter)) !== JSON.stringify(fields.extraFrontmatter) ||
          !sameReferences(references, fields.references);
        if (changed) {
          [row] = await tx<SkillRow[]>`
            UPDATE ai.skills
            SET name = ${fields.name}, description = ${fields.description}, instructions = ${fields.instructions},
                extra_frontmatter = (${JSON.stringify(fields.extraFrontmatter)}::text)::jsonb,
                managed_key = NULL, revision = revision + 1, updated_at = now()
            WHERE id = ${row.id}::uuid
            RETURNING *
          `;
        } else {
          [row] = await tx<SkillRow[]>`
            UPDATE ai.skills SET managed_key = NULL WHERE id = ${row.id}::uuid RETURNING *
          `;
        }
      }

      const currentReferences = await listReferences(row!.id, tx);
      if (!sameReferences(currentReferences, fields.references)) {
        await tx`DELETE FROM ai.skill_references WHERE skill_id = ${row!.id}::uuid`;
        for (const reference of fields.references) {
          await tx`
            INSERT INTO ai.skill_references (skill_id, path, content)
            VALUES (${row!.id}::uuid, ${reference.path}, ${reference.content})
          `;
        }
      }

      const [grant] = await tx<{ id: string; permission: AiSkillPermission }[]>`
        SELECT access.id, access.permission
        FROM ai.skill_access skill_access
        JOIN auth.access access ON access.id = skill_access.access_id
        WHERE skill_access.skill_id = ${row!.id}::uuid AND access.authenticated_only = true
        LIMIT 1
      `;
      if (!grant) {
        await createSkillAccess(row!.id, { principal: { type: "authenticated" }, permission: "read" }, tx);
      } else if (grant.permission !== "read") {
        await tx`UPDATE auth.access SET permission = 'read' WHERE id = ${grant.id}::uuid`;
      }
    });
  },

  async create(input: {
    subject: AccessSubject;
    name: string;
    description: string;
    instructions: string;
    extraFrontmatter?: AiSkillExtraFrontmatter;
    references?: readonly AiSkillReferenceInput[];
  }): Promise<AiSkill> {
    const fields = validatedFields(input);
    return sql.begin(async (tx) => {
      const rows = await withAiShortIdForDb(
        tx,
        "idx_ai_skills_short_id",
        (attempt, shortId) => attempt<SkillRow[]>`
        INSERT INTO ai.skills (short_id, name, description, instructions, extra_frontmatter)
        VALUES (
          ${shortId}, ${fields.name}, ${fields.description}, ${fields.instructions},
          (${JSON.stringify(fields.extraFrontmatter)}::text)::jsonb
        )
        RETURNING *
      `,
      );
      for (const reference of fields.references) {
        await tx`
          INSERT INTO ai.skill_references (skill_id, path, content)
          VALUES (${rows[0]!.id}::uuid, ${reference.path}, ${reference.content})
        `;
      }
      await createSkillAccess(rows[0]!.id, { principal: principalForSubject(input.subject), permission: "admin" }, tx);
      return (await toSkill(rows[0]!, input.subject, tx))!;
    });
  },

  async list(subject: AccessSubject | null): Promise<AiSkillSummary[]> {
    const match = accessMatch(subject);
    const userId = subject?.type === "user" ? subject.userId : null;
    const rows = await sql<SkillSummaryRow[]>`
      SELECT skill.*,
             (array_agg(access.permission ORDER BY
               CASE access.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END DESC
             ))[1] AS permission,
             count(DISTINCT reference.path)::int AS reference_count,
             (disabled.user_id IS NULL) AS enabled
      FROM ai.skills skill
      JOIN ai.skill_access skill_access ON skill_access.skill_id = skill.id
      JOIN auth.access access ON access.id = skill_access.access_id
      LEFT JOIN ai.skill_references reference ON reference.skill_id = skill.id
      LEFT JOIN ai.skill_user_disabled disabled
        ON disabled.skill_id = skill.id AND disabled.user_id = ${userId}::uuid
      WHERE access.permission <> 'none' AND ${match}
      GROUP BY skill.id, disabled.user_id
      ORDER BY skill.name, skill.id
      LIMIT 200
    `;
    return rows.map((row) => ({
      id: row.id,
      shortId: row.short_id,
      name: row.name,
      description: row.description,
      permission: row.permission,
      revision: Number(row.revision),
      referenceCount: Number(row.reference_count),
      enabled: row.enabled,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }));
  },

  async get(skillId: string, subject: AccessSubject | null, required: AiSkillPermission = "read"): Promise<AiSkill | null> {
    return requireSkill(await getRow(skillId), subject, required);
  },

  async getByShortId(shortId: string, subject: AccessSubject | null, required: AiSkillPermission = "read"): Promise<AiSkill | null> {
    return requireSkill(await getRowByShortId(shortId), subject, required);
  },

  async getByName(name: string, subject: AccessSubject | null, required: AiSkillPermission = "read"): Promise<AiSkill | null> {
    return requireSkill(await getRowByName(name), subject, required);
  },

  async update(
    skillId: string,
    subject: AccessSubject | null,
    input: {
      expectedRevision: number;
      name: string;
      description: string;
      instructions: string;
      extraFrontmatter?: AiSkillExtraFrontmatter;
      references?: readonly AiSkillReferenceInput[];
    },
  ): Promise<AiSkill | null> {
    const fields = validatedFields(input);
    return sql.begin(async (tx) => {
      const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
      if (!row || !hasPermission(await permissionFor(row.id, subject, tx), "write")) return null;
      if (Number(row.revision) !== input.expectedRevision) throw new AiSkillRevisionConflictError();
      const [updated] = await tx<SkillRow[]>`
        UPDATE ai.skills
        SET name = ${fields.name}, description = ${fields.description}, instructions = ${fields.instructions},
            extra_frontmatter = (${JSON.stringify(fields.extraFrontmatter)}::text)::jsonb,
            revision = revision + 1, updated_at = now()
        WHERE id = ${skillId}::uuid
        RETURNING *
      `;
      await tx`DELETE FROM ai.skill_references WHERE skill_id = ${skillId}::uuid`;
      for (const reference of fields.references) {
        await tx`
          INSERT INTO ai.skill_references (skill_id, path, content)
          VALUES (${skillId}::uuid, ${reference.path}, ${reference.content})
        `;
      }
      return toSkill(updated!, subject, tx);
    });
  },

  async delete(skillId: string, subject: AccessSubject | null): Promise<boolean> {
    return sql.begin(async (tx) => {
      const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
      if (!row || !hasPermission(await permissionFor(row.id, subject, tx), "admin")) return false;
      const accessIds = (await tx<{ access_id: string }[]>`SELECT access_id FROM ai.skill_access WHERE skill_id = ${skillId}::uuid`).map(
        (entry) => entry.access_id,
      );
      await tx`DELETE FROM ai.skills WHERE id = ${skillId}::uuid`;
      if (accessIds.length) await tx`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(accessIds)}::uuid[])`;
      return true;
    });
  },

  async listAccess(skillId: string, subject: AccessSubject | null): Promise<AiSkillAccess[] | null> {
    if (!(await requireSkill(await getRow(skillId), subject, "admin"))) return null;
    return listSkillAccess(skillId);
  },

  async grantAccess(
    skillId: string,
    subject: AccessSubject | null,
    input: { principal: Principal; permission: AiSkillPermission },
  ): Promise<AiSkillAccess | null> {
    return sql.begin(async (tx) => {
      const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
      if (!row || !hasPermission(await permissionFor(row.id, subject, tx), "admin")) return null;
      return createSkillAccess(skillId, input, tx);
    });
  },

  async updateAccess(skillId: string, accessId: string, subject: AccessSubject | null, permission: AiSkillPermission): Promise<boolean> {
    return sql.begin(async (tx) => {
      const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
      return row && hasPermission(await permissionFor(row.id, subject, tx), "admin")
        ? updateSkillAccess(skillId, accessId, permission, tx)
        : false;
    });
  },

  async revokeAccess(skillId: string, accessId: string, subject: AccessSubject | null): Promise<boolean> {
    return sql.begin(async (tx) => {
      const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
      return row && hasPermission(await permissionFor(row.id, subject, tx), "admin") ? revokeSkillAccess(skillId, accessId, tx) : false;
    });
  },

  admin: {
    async list(params: {
      search?: string;
      page?: number;
      perPage?: number;
    }): Promise<{ items: AiSkillAdminListItem[]; total: number; page: number; perPage: number }> {
      const perPage = Math.min(Math.max(params.perPage ?? 100, 1), 500);
      const page = Math.max(params.page ?? 1, 1);
      const offset = (page - 1) * perPage;
      const pattern = skillSearchPattern(params.search);
      const [countRow] = await sql<{ total: number }[]>`
        SELECT count(*)::int AS total
        FROM ai.skills skill
        WHERE ${pattern}::text IS NULL
          OR lower(skill.name) LIKE ${pattern} ESCAPE '\\'
          OR lower(skill.description) LIKE ${pattern} ESCAPE '\\'
          OR lower(skill.short_id) LIKE ${pattern} ESCAPE '\\'
      `;
      const rows = await sql<AdminSkillRow[]>`
        SELECT skill.*,
               count(DISTINCT reference.path)::int AS reference_count,
               count(DISTINCT skill_access.access_id)::int AS access_count,
               count(DISTINCT skill_access.access_id) FILTER (WHERE access.permission = 'admin')::int AS admin_count
        FROM ai.skills skill
        LEFT JOIN ai.skill_references reference ON reference.skill_id = skill.id
        LEFT JOIN ai.skill_access skill_access ON skill_access.skill_id = skill.id
        LEFT JOIN auth.access access ON access.id = skill_access.access_id
        WHERE ${pattern}::text IS NULL
          OR lower(skill.name) LIKE ${pattern} ESCAPE '\\'
          OR lower(skill.description) LIKE ${pattern} ESCAPE '\\'
          OR lower(skill.short_id) LIKE ${pattern} ESCAPE '\\'
        GROUP BY skill.id
        ORDER BY skill.updated_at DESC, skill.id
        LIMIT ${perPage} OFFSET ${offset}
      `;
      return { items: rows.map(toAdminSkill), total: countRow?.total ?? 0, page, perPage };
    },

    async summary(params: { search?: string } = {}): Promise<AiSkillAdminSummary> {
      const pattern = skillSearchPattern(params.search);
      const [row] = await sql<{ total: number; unmanaged: number; total_access: number }[]>`
        WITH filtered AS (
          SELECT skill.id,
                 count(DISTINCT skill_access.access_id)::int AS access_count,
                 count(DISTINCT skill_access.access_id) FILTER (WHERE access.permission = 'admin')::int AS admin_count
          FROM ai.skills skill
          LEFT JOIN ai.skill_access skill_access ON skill_access.skill_id = skill.id
          LEFT JOIN auth.access access ON access.id = skill_access.access_id
          WHERE ${pattern}::text IS NULL
            OR lower(skill.name) LIKE ${pattern} ESCAPE '\\'
            OR lower(skill.description) LIKE ${pattern} ESCAPE '\\'
            OR lower(skill.short_id) LIKE ${pattern} ESCAPE '\\'
          GROUP BY skill.id
        )
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE admin_count = 0)::int AS unmanaged,
               coalesce(sum(access_count), 0)::int AS total_access
        FROM filtered
      `;
      return { total: row?.total ?? 0, unmanaged: row?.unmanaged ?? 0, totalAccess: row?.total_access ?? 0 };
    },

    async getByShortId(shortId: string): Promise<AiSkillAdminListItem | null> {
      const rows = await sql<AdminSkillRow[]>`
        SELECT skill.*,
               count(DISTINCT reference.path)::int AS reference_count,
               count(DISTINCT skill_access.access_id)::int AS access_count,
               count(DISTINCT skill_access.access_id) FILTER (WHERE access.permission = 'admin')::int AS admin_count
        FROM ai.skills skill
        LEFT JOIN ai.skill_references reference ON reference.skill_id = skill.id
        LEFT JOIN ai.skill_access skill_access ON skill_access.skill_id = skill.id
        LEFT JOIN auth.access access ON access.id = skill_access.access_id
        WHERE skill.short_id = ${shortId}
        GROUP BY skill.id
      `;
      return rows[0] ? toAdminSkill(rows[0]) : null;
    },

    listAccess: listSkillAccess,

    async grantAccess(skillId: string, input: { principal: Principal; permission: AiSkillPermission }): Promise<AiSkillAccess | null> {
      return sql.begin(async (tx) => {
        const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
        if (!row) return null;
        return createSkillAccess(skillId, input, tx);
      });
    },

    async updateAccess(skillId: string, accessId: string, permission: AiSkillPermission): Promise<boolean> {
      return sql.begin(async (tx) => {
        const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
        if (!row) return false;
        return updateSkillAccess(skillId, accessId, permission, tx);
      });
    },

    async revokeAccess(skillId: string, accessId: string): Promise<boolean> {
      return sql.begin(async (tx) => {
        const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
        if (!row) return false;
        return revokeSkillAccess(skillId, accessId, tx);
      });
    },

    async delete(skillId: string): Promise<boolean> {
      return sql.begin(async (tx) => {
        const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
        if (!row) return false;
        const accessIds = (await tx<{ access_id: string }[]>`SELECT access_id FROM ai.skill_access WHERE skill_id = ${skillId}::uuid`).map(
          (entry) => entry.access_id,
        );
        await tx`DELETE FROM ai.skills WHERE id = ${skillId}::uuid`;
        if (accessIds.length) await tx`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(accessIds)}::uuid[])`;
        return true;
      });
    },
  },

  async setEnabled(skillId: string, subject: AccessSubject | null, enabled: boolean): Promise<boolean | null> {
    if (subject?.type !== "user") return null;
    return sql.begin(async (tx) => {
      if (!(await requireSkill(await getRow(skillId, tx), subject, "read", tx))) return null;
      if (enabled) {
        await tx`
          DELETE FROM ai.skill_user_disabled
          WHERE skill_id = ${skillId}::uuid AND user_id = ${subject.userId}::uuid
        `;
      } else {
        await tx`
          INSERT INTO ai.skill_user_disabled (skill_id, user_id)
          VALUES (${skillId}::uuid, ${subject.userId}::uuid)
          ON CONFLICT (skill_id, user_id) DO NOTHING
        `;
      }
      return enabled;
    });
  },

  async setReference(
    skillId: string,
    subject: AccessSubject | null,
    input: { expectedRevision: number; path: string; content: string },
  ): Promise<AiSkill | null> {
    const [reference] = validateAiSkillReferences([{ path: input.path, content: input.content }]);
    return sql.begin(async (tx) => {
      const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
      if (!row || !hasPermission(await permissionFor(row.id, subject, tx), "write")) return null;
      if (Number(row.revision) !== input.expectedRevision) throw new AiSkillRevisionConflictError();
      await tx`
        INSERT INTO ai.skill_references (skill_id, path, content)
        VALUES (${skillId}::uuid, ${reference!.path}, ${reference!.content})
        ON CONFLICT (skill_id, path) DO UPDATE SET content = EXCLUDED.content
      `;
      const [updated] = await tx<SkillRow[]>`
        UPDATE ai.skills SET revision = revision + 1, updated_at = now()
        WHERE id = ${skillId}::uuid RETURNING *
      `;
      return toSkill(updated!, subject, tx);
    });
  },

  async removeReference(
    skillId: string,
    subject: AccessSubject | null,
    input: { expectedRevision: number; path: string },
  ): Promise<AiSkill | null> {
    const [reference] = validateAiSkillReferences([{ path: input.path, content: "" }]);
    return sql.begin(async (tx) => {
      const [row] = await tx<SkillRow[]>`SELECT * FROM ai.skills WHERE id = ${skillId}::uuid FOR UPDATE`;
      if (!row || !hasPermission(await permissionFor(row.id, subject, tx), "write")) return null;
      if (Number(row.revision) !== input.expectedRevision) throw new AiSkillRevisionConflictError();
      const deleted = await tx`
        DELETE FROM ai.skill_references
        WHERE skill_id = ${skillId}::uuid AND path = ${reference!.path}
      `;
      if (deleted.count === 0) return null;
      const [updated] = await tx<SkillRow[]>`
        UPDATE ai.skills SET revision = revision + 1, updated_at = now()
        WHERE id = ${skillId}::uuid RETURNING *
      `;
      return toSkill(updated!, subject, tx);
    });
  },

  async loadForTurn(turnId: string, name: string, subject: AccessSubject | null): Promise<AiLoadedSkillSnapshot | null> {
    return sql.begin(async (tx) => {
      const [row] = await tx<SkillRow[]>`
        SELECT * FROM ai.skills WHERE name = ${validateAiSkillName(name)} FOR SHARE
      `;
      const skill = await requireSkill(row ?? null, subject, "read", tx);
      if (!skill?.enabled) return null;
      const files = skillSnapshotFiles(skill);
      await tx`
        INSERT INTO ai.turn_skill_snapshots (turn_id, skill_id, skill_name, description, revision, instructions, files)
        VALUES (
          ${turnId}::uuid, ${skill.id}::uuid, ${skill.name}, ${skill.description}, ${skill.revision}, ${skill.instructions},
          (${JSON.stringify(files)}::text)::jsonb
        )
        ON CONFLICT DO NOTHING
      `;
      const [snapshot] = await tx<SnapshotRow[]>`
        SELECT skill_name, description, revision, instructions, files, loaded_at
        FROM ai.turn_skill_snapshots
        WHERE turn_id = ${turnId}::uuid AND skill_id = ${skill.id}::uuid
      `;
      return snapshot
        ? {
            name: snapshot.skill_name,
            description: snapshot.description,
            revision: Number(snapshot.revision),
            instructions: snapshot.instructions,
            files: snapshotFiles(snapshot.files).map((file) => ({ ...file, path: mountAiSkillFilePath(file.path) })),
            loadedAt: iso(snapshot.loaded_at),
          }
        : null;
    });
  },

  async listTurnFiles(turnId: string, subject: AccessSubject | null): Promise<AiSkillFileToolStat[]> {
    const match = accessMatch(subject);
    const userId = subject?.type === "user" ? subject.userId : null;
    const rows = await sql<SnapshotRow[]>`
      SELECT DISTINCT snapshot.skill_name, snapshot.description, snapshot.revision, snapshot.instructions,
             snapshot.files, snapshot.loaded_at
      FROM ai.turn_skill_snapshots snapshot
      JOIN ai.skill_access skill_access ON skill_access.skill_id = snapshot.skill_id
      JOIN auth.access access ON access.id = skill_access.access_id
      LEFT JOIN ai.skill_user_disabled disabled
        ON disabled.skill_id = snapshot.skill_id AND disabled.user_id = ${userId}::uuid
      WHERE snapshot.turn_id = ${turnId}::uuid AND access.permission <> 'none' AND ${match}
        AND disabled.user_id IS NULL
      ORDER BY snapshot.skill_name
    `;
    return rows.flatMap((row) =>
      snapshotFiles(row.files).map((file) => ({
        path: file.path,
        mediaType: "text/markdown",
        size: new TextEncoder().encode(file.content).byteLength,
        updatedAt: iso(row.loaded_at),
      })),
    );
  },

  async readTurnFile(turnId: string, path: string, subject: AccessSubject | null): Promise<AiSkillFileToolContent | null> {
    const files = await this.listTurnFiles(turnId, subject);
    const stat = files.find((file) => file.path === path);
    if (!stat) return null;
    const [skillName] = path.split("/", 1);
    const match = accessMatch(subject);
    const userId = subject?.type === "user" ? subject.userId : null;
    const [row] = await sql<SnapshotRow[]>`
      SELECT DISTINCT snapshot.skill_name, snapshot.description, snapshot.revision, snapshot.instructions,
             snapshot.files, snapshot.loaded_at
      FROM ai.turn_skill_snapshots snapshot
      JOIN ai.skill_access skill_access ON skill_access.skill_id = snapshot.skill_id
      JOIN auth.access access ON access.id = skill_access.access_id
      LEFT JOIN ai.skill_user_disabled disabled
        ON disabled.skill_id = snapshot.skill_id AND disabled.user_id = ${userId}::uuid
      WHERE snapshot.turn_id = ${turnId}::uuid AND snapshot.skill_name = ${skillName}
        AND access.permission <> 'none' AND ${match} AND disabled.user_id IS NULL
      LIMIT 1
    `;
    const file = row ? snapshotFiles(row.files).find((entry) => entry.path === path) : null;
    return file ? { ...stat, bytes: new TextEncoder().encode(file.content) } : null;
  },
};
