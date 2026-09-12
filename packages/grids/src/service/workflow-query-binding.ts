import { err, fail, ok } from "@k2b/stdlib";
import { sql } from "bun";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import type { WorkflowQueryBinder } from "../workflows/binder";
import type { SqlClient } from "./audit";
import { documentServiceText } from "./document-messages";
import { buildTrustedGqlResolverContext } from "./gql-resolver-context";
import type { WorkflowCatalog } from "./workflow-catalog";
import { bindWorkflowQueryData } from "./workflow-query-data";

/** The same catalog that authorizes ordinary workflow bindings restricts GQL.
 * Loading metadata internally does not grant access to hidden tables or fields. */
export const workflowQueryBinder =
  (
    baseId: string,
    catalog: WorkflowCatalog,
    client: SqlClient = sql,
    locale?: string,
    schemaHashVersion: 1 | 2 | 3 = 3,
  ): WorkflowQueryBinder =>
  async (source, values) => {
    const t = documentServiceText(locale);
    const parsed = parseGridsQueryDsl(source);
    if (!parsed.ok) return fail(err.badInput(t.sourceInvalid));
    const context = await buildTrustedGqlResolverContext({ baseId, ast: parsed.ast, purpose: "workflow-query", client });
    const tables = new Set([...catalog.tables.refs.values()].map((table) => table.id));
    context.tables = context.tables?.filter((table) => tables.has(table.id));
    context.views = [];
    context.fieldsByTableId = Object.fromEntries(
      Object.entries(context.fieldsByTableId)
        .filter(([id]) => tables.has(id))
        .map(([id, fields]) => {
          const allowed = new Set([...(catalog.fieldsByTable.get(id)?.refs.values() ?? [])].map((field) => field.id));
          return [id, fields.filter((field) => allowed.has(field.id))];
        }),
    );
    const bound = bindWorkflowQueryData(source, context, values, locale, { parameterTypesOnly: true, schemaHashVersion });
    if (!bound.ok) return bound;
    if (bound.data.tableIds.some((id) => !tables.has(id))) return fail(err.forbidden(t.workflowQueryAccessDenied));
    return ok(bound.data.binding);
  };
