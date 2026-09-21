import { crypto, type DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import { customAppDocumentPreviewSourceIsSafe } from "../custom-apps/document-preview-capability";
import { customAppFieldConfig, stableCustomAppStringify } from "../custom-apps/stable-value";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { dslQueryReferencedFieldIds } from "../query-dsl/plan-dependencies";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { collectDslPlanExtraFieldTableIds, collectDslPlanTableIds } from "../query-dsl/source-plan";
import type { SqlClient } from "./audit";
import { buildLiveRenderData, buildTemplateAppData } from "./document-rendering";
import { getStoredTemplate } from "./document-templates";
import { listByTables } from "./fields";
import { buildTrustedGqlResolverContext } from "./gql-resolver-context";
import { get as getRecord } from "./records";
import { get as getTable } from "./tables";

/** Pin the source plan and its dependencies. Liquid also reads the complete
 * root record, including transitive computed fields. Unrelated Base resources
 * and presentation-only field changes do not invalidate this capability.
 */
export const customAppDocumentPreviewFingerprint = async (
  client: SqlClient,
  baseId: string,
  tableId: string,
  templateId: string,
): Promise<string | null> => {
  const template = await getStoredTemplate(templateId, client);
  if (
    !template ||
    template.deletedAt ||
    !template.enabled ||
    template.tableId !== tableId ||
    !customAppDocumentPreviewSourceIsSafe(template.source)
  )
    return null;
  const parsedSource = parseGridsQueryDsl(template.source.replace(/\{\{\s*record\.(?:id|shortId)\s*\}\}/g, "ABC123"));
  if (!parsedSource.ok) return null;
  const context = await buildTrustedGqlResolverContext({
    baseId,
    currentTableId: tableId,
    ast: parsedSource.ast,
    purpose: "document-template-render",
    client,
  });
  const resolved = resolveDslQueryToQueryPlan(parsedSource.ast, context);
  if (!resolved.ok) return null;
  const missing = context.tables.map((table) => table.id).filter((id) => !context.fieldsByTableId[id]);
  const extraFields = await listByTables(missing, client);
  const fieldsByTableId = { ...context.fieldsByTableId, ...Object.fromEntries(extraFields) };
  const fieldIds = dslQueryReferencedFieldIds(
    resolved.plan,
    fieldsByTableId,
    (fieldsByTableId[tableId] ?? []).map((field) => field.id),
  );
  const fields = Object.values(fieldsByTableId)
    .flat()
    .filter((field) => fieldIds.has(field.id))
    .map((field) => ({
      id: field.id,
      shortId: field.shortId,
      tableId: field.tableId,
      name: field.name,
      type: field.type,
      config: customAppFieldConfig(field),
      required: field.required,
      presentable: field.presentable,
      position: field.position,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const tableIds = new Set([
    tableId,
    ...collectDslPlanTableIds(resolved.plan, fieldsByTableId),
    ...collectDslPlanExtraFieldTableIds(resolved.plan),
    ...fields.map((field) => field.tableId),
  ]);
  const tables = await client<Array<{ id: string; schema: unknown }>>`
    SELECT id, jsonb_build_object('id', id, 'short_id', short_id, 'base_id', base_id,
      'kind', kind, 'name', name, 'audit_policy', audit_policy,
      'finalization_policy_revision', finalization_policy_revision) AS schema FROM grids.tables t
    WHERE base_id = ${baseId}::uuid AND id = ANY(${sql.array([...tableIds], "UUID")}::uuid[]) AND deleted_at IS NULL ORDER BY id
  `;
  if (!tables.some((table) => table.id === tableId)) return null;
  return crypto.common.hash(
    stableCustomAppStringify({
      baseId,
      tableId,
      templateId,
      source: template.source,
      renderer: template.renderer,
      name: template.name,
      tables,
      fields,
      plan: { ...resolved.plan, readableTableIds: [...tableIds].sort() },
    }),
  );
};

/** Caller has resolved the published page and its record capability. Never take
 * a raw request record ID here without that check. Pin/check/read share one
 * snapshot; no query text, number or persisted document comes from the caller.
 */
export const prepareCustomAppDocumentPreview = async (input: {
  baseId: string;
  tableId: string;
  templateId: string;
  fingerprint: string;
  recordId: string;
  recordVersion: number;
  dateConfig: DateContext;
  signal: AbortSignal;
  authorize: (client: SqlClient) => Promise<boolean>;
}) => {
  const app = await buildTemplateAppData();
  return sql.begin(async (client) => {
    await client`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
    input.signal.throwIfAborted();
    if (!(await input.authorize(client))) return null;
    if ((await customAppDocumentPreviewFingerprint(client, input.baseId, input.tableId, input.templateId)) !== input.fingerprint)
      return null;
    const template = await getStoredTemplate(input.templateId, client);
    const table = await getTable(input.tableId, { client });
    if (!template || !table) return null;
    const record = await getRecord(input.tableId, input.recordId, {
      client,
      dateConfig: input.dateConfig,
      templateApp: app,
      viewer: { userId: null, userGroups: [], isAdmin: true },
    });
    if (!record || record.finalizedAt || record.version !== input.recordVersion) return null;
    const createdAt = new Date();
    const rendered = await buildLiveRenderData({
      client,
      template,
      table,
      record,
      app,
      dateConfig: input.dateConfig,
      createdAt,
      includeScanMetadata: false,
      signal: input.signal,
    });
    return { template, createdAt, rendered };
  });
};
