import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { type BaseNavigation, BaseNavigationSchema, navigationReferenceKey } from "../navigation-contracts";
import { navigationMessages } from "../navigation-messages";
import { logAudit, type SqlClient } from "./audit";
import { parseJsonbRow } from "./jsonb";
import { emitMetadataEvent } from "./metadata-events";

export const getBaseNavigation = async (baseId: string, client: SqlClient = sql): Promise<BaseNavigation | null> => {
  const [row] = await client`SELECT navigation_groups AS groups, navigation_revision AS revision
    FROM grids.bases WHERE id = ${baseId}::uuid AND deleted_at IS NULL`;
  return row ? BaseNavigationSchema.parse({ ...row, groups: parseJsonbRow(row.groups, []) }) : null;
};

// Stored references use the same stable short IDs as other authored Grids configuration.
// They never become UUID SQL parameters, and labels are always resolved at read time.
export const updateBaseNavigation = async (
  baseId: string,
  input: BaseNavigation,
  actorId: string | null,
  locale?: string,
): Promise<Result<BaseNavigation>> => {
  const { t } = navigationMessages.resolve(locale ? [locale] : []);
  const parsed = BaseNavigationSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(t.invalid));
  const result = await sql.begin(async (tx): Promise<Result<BaseNavigation>> => {
    const [base] = await tx`SELECT id FROM grids.bases WHERE id = ${baseId}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (!base) return fail(err.notFound("Base"));
    const current = (await getBaseNavigation(baseId, tx))!;
    if (current.revision !== input.revision) return fail(err.conflict(t.conflict));
    const targets = await tx<{ type: string; id: string }[]>`
      SELECT 'table' AS type, short_id AS id FROM grids.tables WHERE base_id = ${baseId}::uuid AND deleted_at IS NULL
      UNION ALL SELECT 'view', v.short_id FROM grids.views v JOIN grids.tables t ON t.id = v.table_id
        WHERE t.base_id = ${baseId}::uuid AND t.deleted_at IS NULL AND v.deleted_at IS NULL
      UNION ALL SELECT 'form', f.short_id FROM grids.forms f JOIN grids.tables t ON t.id = f.table_id
        WHERE t.base_id = ${baseId}::uuid AND t.deleted_at IS NULL AND f.deleted_at IS NULL
      UNION ALL SELECT 'documentTemplate', d.short_id FROM grids.document_templates d JOIN grids.tables t ON t.id = d.table_id
        WHERE t.base_id = ${baseId}::uuid AND t.deleted_at IS NULL AND d.deleted_at IS NULL
      UNION ALL SELECT 'workflow', short_id FROM grids.workflow_profile WHERE base_id = ${baseId}::uuid AND deleted_at IS NULL
      UNION ALL SELECT 'customApp', short_id FROM grids.custom_apps WHERE base_id = ${baseId}::uuid AND deleted_at IS NULL
    `;
    const allowed = new Set(targets.map((target) => `${target.type}:${target.id}`));
    // Existing missing references can be retained while editing another group.
    const existing = new Set(current.groups.flatMap((group) => group.entries.map(navigationReferenceKey)));
    if (
      input.groups.some((group) =>
        group.entries.some((entry) => !allowed.has(navigationReferenceKey(entry)) && !existing.has(navigationReferenceKey(entry))),
      )
    )
      return fail(err.badInput(t.invalidTarget));
    const next = { revision: current.revision + 1, groups: parsed.data.groups };
    await tx`UPDATE grids.bases SET navigation_groups = ${JSON.stringify(next.groups)}::jsonb, navigation_revision = ${next.revision}, updated_at = now()
      WHERE id = ${baseId}::uuid`;
    await logAudit({ baseId, userId: actorId, action: "updated", diff: { navigation: { old: current.groups, new: next.groups } } }, tx);
    return ok(next);
  });
  if (result.ok) await emitMetadataEvent({ type: "base.updated", baseId, resource: { kind: "base", id: baseId }, actorId });
  return result;
};
