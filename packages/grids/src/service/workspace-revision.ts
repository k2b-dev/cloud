import { sql } from "bun";

/** Small, record-independent snapshot. Hashes are change detectors, not integrity proofs. */
export type WorkspaceRevision = { revision: string; resources: Record<string, string> };

export const workspaceRevisionHeader = "X-Grids-Workspace-Revision";

/**
 * Structure is what a stale tab would render or validate wrongly: names, field
 * schema, query sources, definitions, and content. Presentation (columns,
 * display config, view ui, icons, descriptions), ordering (position),
 * ownership, policies the server enforces on its own, and bookkeeping
 * timestamps are not structure; writing them never announces a change.
 */
const bookkeeping = ["created_at", "updated_at", "deleted_at", "created_by", "updated_by"];
const structureOf = (alias: string, excluded: string[]) =>
  sql.unsafe(`(to_jsonb(${alias}) - '{${[...bookkeeping, ...excluded].join(",")}}'::text[])`);
const tableStructure = structureOf("t", [
  "description",
  "icon",
  "columns",
  "display_config",
  "audit_policy",
  "mutation_policy",
  "position",
  "disable_direct_insert",
  "finalization_policy_revision",
]);
const fieldStructure = structureOf("f", ["description", "icon", "position", "indexed", "hide_in_table", "presentable"]);
/** Shared with the draft save so an own write acknowledges exactly its committed row. */
export const customAppStructure = (alias: string) => structureOf(alias, []);

export const loadWorkspaceRevision = async (baseId: string): Promise<WorkspaceRevision> => {
  const [row] = await sql<Array<WorkspaceRevision>>`
    WITH resources AS (
      SELECT 'base:' || b.short_id AS key, md5(${structureOf("b", ["navigation_groups", "navigation_revision"])}::text) AS revision
        FROM grids.bases b WHERE b.id = ${baseId}::uuid AND b.deleted_at IS NULL
      UNION ALL
      SELECT 'table:' || t.short_id, md5((${tableStructure} || jsonb_build_object('fields',
        (SELECT jsonb_agg(${fieldStructure} ORDER BY f.id) FROM grids.fields f WHERE f.table_id = t.id AND f.deleted_at IS NULL)))::text)
        FROM grids.tables t WHERE t.base_id = ${baseId}::uuid AND t.deleted_at IS NULL
      UNION ALL
      SELECT 'view:' || v.short_id, md5(${structureOf("v", ["name", "description", "icon", "ui", "owner_user_id", "position"])}::text)
        FROM grids.views v WHERE v.base_id = ${baseId}::uuid AND v.deleted_at IS NULL
      UNION ALL
      SELECT 'form:' || f.short_id, md5(${structureOf("f", ["name", "owner_user_id", "position", "public_token"])}::text)
        FROM grids.forms f JOIN grids.tables t ON t.id = f.table_id
        WHERE t.base_id = ${baseId}::uuid AND f.deleted_at IS NULL AND t.deleted_at IS NULL
      UNION ALL
      SELECT 'document:' || d.short_id, md5(${structureOf("d", ["description", "position"])}::text)
        FROM grids.document_templates d JOIN grids.tables t ON t.id = d.table_id
        WHERE t.base_id = ${baseId}::uuid AND d.deleted_at IS NULL AND t.deleted_at IS NULL
      UNION ALL
      SELECT 'workflow:' || w.short_id, md5(${structureOf("w", ["owner_user_id", "position", "record_event_active_since"])}::text)
        FROM grids.workflow_profile w WHERE w.base_id = ${baseId}::uuid AND w.deleted_at IS NULL
      UNION ALL
      SELECT 'app:' || a.short_id, md5(${customAppStructure("a")}::text) FROM grids.custom_apps a WHERE a.base_id = ${baseId}::uuid AND a.deleted_at IS NULL
      UNION ALL
      SELECT 'email:' || e.short_id, md5(${structureOf("e", ["description", "position"])}::text)
        FROM grids.email_templates e WHERE e.base_id = ${baseId}::uuid AND e.deleted_at IS NULL
    )
    SELECT md5(COALESCE(string_agg(key || revision, ',' ORDER BY key), '')) AS revision,
      COALESCE(jsonb_object_agg(key, revision), '{}'::jsonb) AS resources FROM resources
  `;
  if (!row) throw new Error("Workspace revision unavailable");
  return row;
};

/** Current revision of one resource after a write; `undefined` when it is gone. */
export const loadResourceRevision = async (baseId: string, key: string): Promise<string | undefined> =>
  (await loadWorkspaceRevision(baseId)).resources[key];
