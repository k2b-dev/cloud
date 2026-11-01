import { sql } from "@k2b/cloud";
import { type GridsWorkflow, GridsWorkflowSchema } from "../workflows/contracts";
import type { SqlClient } from "./audit";

type DbRow = Record<string, unknown>;

const WORKFLOW_SELECT = () =>
  sql.unsafe(`
  p.id, p.short_id, p.base_id, w.name, w.description,
  v.source, v.plan, v.diagnostics, v.revision,
  p.enabled, p.position, p.owner_user_id, p.deleted_at, p.created_at, p.updated_at
`);

const WORKFLOW_FROM = () =>
  sql.unsafe(`
  FROM grids.workflow_profile AS p
  JOIN workflows.workflow AS w ON w.id = p.id
  LEFT JOIN LATERAL (
    SELECT source, plan, diagnostics, revision
    FROM workflows.version
    WHERE workflow_id = p.id
    ORDER BY revision DESC
    LIMIT 1
  ) AS v ON TRUE
`);

const mapWorkflow = (row: DbRow): GridsWorkflow => {
  const parsed = GridsWorkflowSchema.safeParse({
    id: row.id,
    shortId: row.short_id,
    baseId: row.base_id,
    name: row.name,
    description: row.description ?? null,
    source: row.source,
    plan: row.plan,
    diagnostics: row.diagnostics,
    enabled: row.enabled,
    position: row.position,
    revision: row.revision,
    ownerUserId: row.owner_user_id ?? null,
    deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  });
  if (!parsed.success) throw new Error(`stored workflow ${String(row.id)} is invalid: ${parsed.error.message}`);
  return parsed.data;
};

export const getWorkflow = async (id: string, includeDeleted = false, client: SqlClient = sql): Promise<GridsWorkflow | null> => {
  const [row] = await client<DbRow[]>`
    SELECT ${WORKFLOW_SELECT()} ${WORKFLOW_FROM()}
    WHERE p.id = ${id}::uuid AND (${includeDeleted} = TRUE OR p.deleted_at IS NULL)
  `;
  return row ? mapWorkflow(row) : null;
};

export const getWorkflowByShortIdForBase = async (baseId: string, shortId: string): Promise<GridsWorkflow | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT ${WORKFLOW_SELECT()} ${WORKFLOW_FROM()}
    WHERE p.base_id = ${baseId}::uuid
      AND p.deleted_at IS NULL
      AND p.short_id = ${shortId}
  `;
  return row ? mapWorkflow(row) : null;
};

export const listWorkflows = async (baseId: string, enabledOnly = false, includeDeleted = false): Promise<GridsWorkflow[]> => {
  const rows = await sql<DbRow[]>`
    SELECT ${WORKFLOW_SELECT()} ${WORKFLOW_FROM()}
    WHERE p.base_id = ${baseId}::uuid
      AND (${includeDeleted} = TRUE OR p.deleted_at IS NULL)
      AND (${enabledOnly} = FALSE OR p.enabled = TRUE)
    ORDER BY p.position, p.created_at, p.id
  `;
  return rows.map(mapWorkflow);
};

export const listWorkflowScopes = async (baseId: string, includeDeleted = false): Promise<Array<Pick<GridsWorkflow, "id" | "baseId">>> => {
  const rows = await sql<Array<{ id: string; base_id: string }>>`
    SELECT id::text AS id, base_id::text AS base_id
    FROM grids.workflow_profile
    WHERE base_id = ${baseId}::uuid AND (${includeDeleted} = TRUE OR deleted_at IS NULL)
    ORDER BY position, created_at, id
  `;
  return rows.map((row) => ({ id: row.id, baseId: row.base_id }));
};

export const listScheduledWorkflows = async (): Promise<GridsWorkflow[]> => {
  const rows = await sql<DbRow[]>`
    SELECT ${WORKFLOW_SELECT()} ${WORKFLOW_FROM()}
    WHERE p.deleted_at IS NULL
      AND p.enabled = TRUE
      AND jsonb_path_exists(v.plan, '$.triggers[*] ? (@.kind == "schedule")')
    ORDER BY p.created_at, p.id
  `;
  return rows.map(mapWorkflow);
};

export const listRecordEventBaseIds = async (): Promise<string[]> => {
  const rows = await sql<Array<{ id: string }>>`
    SELECT DISTINCT p.base_id::text AS id
    ${WORKFLOW_FROM()}
    WHERE p.deleted_at IS NULL
      AND p.enabled = TRUE
      AND p.record_event_active_since IS NOT NULL
      AND jsonb_path_exists(v.plan, '$.triggers[*] ? (@.kind == "recordEvent")')
    ORDER BY id
  `;
  return rows.map((row) => row.id);
};

export const listRecordEventWorkflows = async (baseId: string, occurredAt: string): Promise<GridsWorkflow[]> => {
  const rows = await sql<DbRow[]>`
    SELECT ${WORKFLOW_SELECT()} ${WORKFLOW_FROM()}
    WHERE p.base_id = ${baseId}::uuid
      AND p.deleted_at IS NULL
      AND p.enabled = TRUE
      AND p.record_event_active_since IS NOT NULL
      AND p.record_event_active_since <= ${occurredAt}::timestamptz
      AND jsonb_path_exists(v.plan, '$.triggers[*] ? (@.kind == "recordEvent")')
    ORDER BY p.position, p.created_at, p.id
  `;
  return rows.map(mapWorkflow);
};
