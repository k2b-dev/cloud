import { sql } from "bun";

/** Small, record-independent snapshot. Hashes are change detectors, not integrity proofs. */
export type WorkspaceRevision = { revision: string; resources: Record<string, string> };

export const loadWorkspaceRevision = async (baseId: string): Promise<WorkspaceRevision> => {
  const [row] = await sql<Array<WorkspaceRevision>>`
    WITH resources AS (
      SELECT 'base:' || b.short_id AS key, md5(to_jsonb(b)::text) AS revision FROM grids.bases b
        WHERE b.id = ${baseId}::uuid AND b.deleted_at IS NULL
      UNION ALL
      SELECT 'table:' || t.short_id, md5((to_jsonb(t) || jsonb_build_object('fields',
        (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM grids.fields f WHERE f.table_id = t.id AND f.deleted_at IS NULL)))::text)
        FROM grids.tables t WHERE t.base_id = ${baseId}::uuid AND t.deleted_at IS NULL
      UNION ALL
      SELECT 'view:' || v.short_id, md5(to_jsonb(v)::text) FROM grids.views v WHERE v.base_id = ${baseId}::uuid AND v.deleted_at IS NULL
      UNION ALL
      SELECT 'form:' || f.short_id, md5(to_jsonb(f)::text) FROM grids.forms f JOIN grids.tables t ON t.id = f.table_id
        WHERE t.base_id = ${baseId}::uuid AND f.deleted_at IS NULL AND t.deleted_at IS NULL
      UNION ALL
      SELECT 'document:' || d.short_id, md5(to_jsonb(d)::text) FROM grids.document_templates d JOIN grids.tables t ON t.id = d.table_id
        WHERE t.base_id = ${baseId}::uuid AND d.deleted_at IS NULL AND t.deleted_at IS NULL
      UNION ALL
      SELECT 'workflow:' || w.short_id, md5(to_jsonb(w)::text) FROM grids.workflow_profile w WHERE w.base_id = ${baseId}::uuid AND w.deleted_at IS NULL
      UNION ALL
      SELECT 'app:' || a.short_id, md5(to_jsonb(a)::text) FROM grids.custom_apps a WHERE a.base_id = ${baseId}::uuid AND a.deleted_at IS NULL
      UNION ALL
      SELECT 'email:' || e.short_id, md5(to_jsonb(e)::text) FROM grids.email_templates e WHERE e.base_id = ${baseId}::uuid AND e.deleted_at IS NULL
    )
    SELECT md5(COALESCE(string_agg(key || revision, ',' ORDER BY key), '')) AS revision,
      COALESCE(jsonb_object_agg(key, revision), '{}'::jsonb) AS resources FROM resources
  `;
  if (!row) throw new Error("Workspace revision unavailable");
  return row;
};
