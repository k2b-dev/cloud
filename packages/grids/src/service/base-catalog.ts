import { sql } from "@k2b/cloud";
import type { PermissionLevel } from "@k2b/cloud/server";
import {
  type DocumentTemplate,
  FieldColumnSpecSchema,
  RecordDisplayConfigSchema,
  TableAuditPolicySchema,
  TableMutationPolicySchema,
  type View,
  ViewUiSettingsSchema,
} from "../contracts";
import { withNormalizedSelectColors } from "../field-types/select-colors";
import type { GridsWorkflow } from "../workflows/contracts";
import { CUSTOM_APP_SUMMARY_COLUMNS, type CustomAppSummary, mapSummaryRow } from "./custom-apps";
import { mapDocumentTemplate } from "./document-mappers";
import { type Form, normalizeFormConfig, toRenderableForm } from "./forms";
import { parseJsonbRow } from "./jsonb";
import { withLookupTargetMetadata } from "./lookup-display";
import { hasAtLeast, loadBaseGrantsForSubject, resolveEffectivePermission } from "./permission-resolver";
import type { Field, Table } from "./types";
import { mapWorkflow, WORKFLOW_FROM, WORKFLOW_SELECT } from "./workflow-read";

type DbRow = Record<string, unknown>;

type RankedTable = Table & { level: PermissionLevel };

type BaseCatalog = {
  tables: RankedTable[];
  tableLevels: Record<string, PermissionLevel>;
  fieldsByTable: Record<string, Field[]>;
  viewsByTable: Record<string, View[]>;
  formsByTable: Record<string, Form[]>;
  formLevels: Record<string, PermissionLevel>;
  formTables: Table[];
  sidebarForms: Array<{ form: Form; tableId: string }>;
  documentTemplatesByTable: Record<string, DocumentTemplate[]>;
  documentTemplateLevels: Record<string, PermissionLevel>;
  documentTemplateTables: Table[];
  sidebarDocumentTemplates: Array<{ template: DocumentTemplate; tableId: string }>;
  workflows: GridsWorkflow[];
  customApps: CustomAppSummary[];
};

/** One row of the catalog statement: each kind of resource as a JSON array of its rows. */
type CatalogRow = Record<"tables" | "fields" | "views" | "forms" | "document_templates" | "workflows" | "custom_apps", DbRow[]>;

/** The timestamps a row carries as JSON text, back to the dates the mappers read from a plain row. */
const fromJson = (row: DbRow): DbRow => {
  const out = { ...row };
  for (const key of ["created_at", "updated_at", "deleted_at", "published_at"]) {
    const value = out[key];
    if (typeof value === "string") out[key] = new Date(value);
  }
  return out;
};

const parseColumns = (raw: unknown) => {
  const parsed = FieldColumnSpecSchema.array().safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
};

const parseDisplayConfig = (raw: unknown) => {
  const parsed = RecordDisplayConfigSchema.safeParse(parseJsonbRow<unknown>(raw, { mode: "table" }));
  return parsed.success ? parsed.data : { mode: "table" as const };
};

const parseViewUi = (raw: unknown) => {
  const parsed = ViewUiSettingsSchema.safeParse(parseJsonbRow<unknown>(raw, {}));
  return parsed.success ? parsed.data : {};
};

const mapTable = (row: DbRow): Table => ({
  id: row.id as string,
  shortId: row.short_id as string,
  baseId: row.base_id as string,
  kind: row.kind === "federated" ? "federated" : "stored",
  name: row.name as string,
  description: (row.description as string | null) ?? null,
  icon: (row.icon as string | null) ?? null,
  columns: parseColumns(row.columns),
  displayConfig: parseDisplayConfig(row.display_config),
  auditPolicy: TableAuditPolicySchema.parse(parseJsonbRow<unknown>(row.audit_policy, {})),
  mutationPolicy: TableMutationPolicySchema.parse(parseJsonbRow<unknown>(row.mutation_policy, null)),
  position: row.position as number,
  disableDirectInsert: (row.disable_direct_insert as boolean | null) ?? false,
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
});

const mapField = (row: DbRow): Field => ({
  id: row.id as string,
  shortId: row.short_id as string,
  tableId: row.table_id as string,
  name: row.name as string,
  description: (row.description as string | null) ?? null,
  icon: (row.icon as string | null) ?? null,
  type: row.type as string,
  config: withNormalizedSelectColors(row.type as string, parseJsonbRow<Record<string, unknown>>(row.config, {})),
  position: row.position as number,
  required: row.required as boolean,
  presentable: (row.presentable as boolean | null) ?? false,
  hideInTable: (row.hide_in_table as boolean | null) ?? false,
  defaultValue: row.default_value ?? null,
  indexed: row.indexed as boolean,
  uniqueConstraint: row.unique_constraint as boolean,
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
});

const mapView = (row: DbRow): View => ({
  id: row.id as string,
  shortId: row.short_id as string,
  tableId: row.table_id as string,
  name: row.name as string,
  description: (row.description as string | null) ?? null,
  icon: (row.icon as string | null) ?? null,
  source: row.source as string,
  ui: parseViewUi(row.ui),
  ownerUserId: (row.owner_user_id as string | null) ?? null,
  position: row.position as number,
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
});

const mapForm = (row: DbRow): Form => ({
  id: row.id as string,
  shortId: row.short_id as string,
  tableId: row.table_id as string,
  name: row.name as string,
  config: normalizeFormConfig(row.config),
  publicToken: (row.public_token as string | null) ?? null,
  isActive: row.is_active as boolean,
  ownerUserId: (row.owner_user_id as string | null) ?? null,
  position: row.position as number,
  isDefault: false,
  deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
  createdAt: (row.created_at as Date).toISOString(),
  updatedAt: (row.updated_at as Date).toISOString(),
});

const byTable = <T extends { tableId: string }>(items: T[]): Record<string, T[]> => {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const tableItems = out[item.tableId] ?? [];
    tableItems.push(item);
    out[item.tableId] = tableItems;
  }
  return out;
};

/** `customApps`: also the base's apps, for who manages the base. */
export const listForBase = async (params: {
  baseId: string;
  userId: string;
  userGroups: string[];
  customApps?: boolean;
}): Promise<BaseCatalog> => {
  const grants = await loadBaseGrantsForSubject({ baseId: params.baseId, subject: { type: "user", userId: params.userId } });
  const level = resolveEffectivePermission(grants, { baseId: params.baseId });
  if (!hasAtLeast(level, "read")) {
    return {
      tables: [],
      tableLevels: {},
      fieldsByTable: {},
      viewsByTable: {},
      formsByTable: {},
      formLevels: {},
      formTables: [],
      sidebarForms: [],
      documentTemplatesByTable: {},
      documentTemplateLevels: {},
      documentTemplateTables: [],
      sidebarDocumentTemplates: [],
      workflows: [],
      customApps: [],
    };
  }

  // Everything the base's navigation lists in one statement: each kind as a JSON array in its own order, live
  // resources of live tables of a live base only, as the separate reads had it. Apps only when asked (who manages
  // the base); workflows always, at the base's level.
  const [row] = await sql<CatalogRow[]>`
    SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.position, t.created_at), '[]'::jsonb)
         FROM grids.tables t
        WHERE t.base_id = b.id AND t.deleted_at IS NULL) AS tables,
      (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.table_id, f.position, f.created_at), '[]'::jsonb)
         FROM grids.fields f
         JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
        WHERE t.base_id = b.id AND f.deleted_at IS NULL) AS fields,
      (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.table_id, v.position, v.created_at), '[]'::jsonb)
         FROM grids.views v
         JOIN grids.tables t ON t.id = v.table_id AND t.deleted_at IS NULL
        WHERE t.base_id = b.id AND v.deleted_at IS NULL) AS views,
      (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.table_id, f.position, f.created_at), '[]'::jsonb)
         FROM grids.forms f
         JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
        WHERE t.base_id = b.id AND f.deleted_at IS NULL) AS forms,
      (SELECT COALESCE(jsonb_agg(to_jsonb(dt) ORDER BY dt.table_id, dt.position, dt.created_at), '[]'::jsonb)
         FROM grids.document_templates dt
         JOIN grids.tables t ON t.id = dt.table_id AND t.deleted_at IS NULL
        WHERE t.base_id = b.id AND dt.deleted_at IS NULL) AS document_templates,
      (SELECT COALESCE(jsonb_agg(to_jsonb(wf) ORDER BY wf.position, wf.created_at, wf.id), '[]'::jsonb)
         FROM (SELECT ${WORKFLOW_SELECT()} ${WORKFLOW_FROM()} WHERE p.base_id = b.id AND p.deleted_at IS NULL) wf) AS workflows,
      CASE WHEN ${params.customApps === true} THEN
        (SELECT COALESCE(jsonb_agg(to_jsonb(ca) ORDER BY ca.name, ca.id), '[]'::jsonb)
           FROM (SELECT ${CUSTOM_APP_SUMMARY_COLUMNS()} FROM grids.custom_apps WHERE base_id = b.id AND deleted_at IS NULL) ca)
      ELSE '[]'::jsonb END AS custom_apps
    FROM grids.bases b
    WHERE b.id = ${params.baseId}::uuid AND b.deleted_at IS NULL
  `;
  const rows = (key: keyof CatalogRow) => (row?.[key] ?? []).map(fromJson);
  const [tableRows, fieldRows, viewRows, formRows, documentTemplateRows] = [
    rows("tables"),
    rows("fields"),
    rows("views"),
    rows("forms"),
    rows("document_templates"),
  ];

  const tables = tableRows.map((row) => ({ ...mapTable(row), level }));
  const tableLevels = Object.fromEntries(tables.map((table) => [table.id, table.level]));
  const fieldsByTable = byTable(await withLookupTargetMetadata(fieldRows.map(mapField)));
  const viewsByTable = byTable(viewRows.map(mapView));
  const forms = formRows.map(mapForm).map((form) => (level === "admin" ? form : toRenderableForm(form)));
  const formsByTable = byTable(forms);
  const formLevels = Object.fromEntries(forms.map((form) => [form.id, level]));
  const sidebarForms = hasAtLeast(level, "write")
    ? forms.filter((form) => form.isActive).map((form) => ({ form, tableId: form.tableId }))
    : [];
  const documentTemplates = documentTemplateRows.map(mapDocumentTemplate);
  const documentTemplatesByTable = byTable(documentTemplates);
  const documentTemplateLevels = Object.fromEntries(documentTemplates.map((template) => [template.id, level]));
  const sidebarDocumentTemplates = documentTemplates
    .filter((template) => template.enabled)
    .map((template) => ({ template, tableId: template.tableId }));

  return {
    tables,
    tableLevels,
    fieldsByTable,
    viewsByTable,
    formsByTable,
    formLevels,
    formTables: [],
    sidebarForms,
    documentTemplatesByTable,
    documentTemplateLevels,
    documentTemplateTables: [],
    sidebarDocumentTemplates,
    workflows: rows("workflows").map(mapWorkflow),
    customApps: rows("custom_apps").map(mapSummaryRow),
  };
};
