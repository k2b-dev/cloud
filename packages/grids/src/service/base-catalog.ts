import type { PermissionLevel } from "@k2b/cloud/server";
import { sql } from "bun";
import {
  type DocumentTemplate,
  FieldColumnSpecSchema,
  RecordDisplayConfigSchema,
  TableAuditPolicySchema,
  TableMutationPolicySchema,
  type View,
  ViewUiSettingsSchema,
} from "../contracts";
import { mapDocumentTemplate } from "./document-mappers";
import { type Form, normalizeFormConfig, toRenderableForm } from "./forms";
import { parseJsonbRow } from "./jsonb";
import { withLookupTargetMetadata } from "./lookup-display";
import { hasAtLeast, loadBaseGrantsForSubject, resolveEffectivePermission } from "./permission-resolver";
import type { Field, Table } from "./types";

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
  config: parseJsonbRow<Record<string, unknown>>(row.config, {}),
  position: row.position as number,
  required: row.required as boolean,
  presentable: (row.presentable as boolean | null) ?? false,
  hideInTable: (row.hide_in_table as boolean | null) ?? false,
  defaultValue: parseJsonbRow<unknown>(row.default_value, null),
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

export const listForBase = async (params: { baseId: string; userId: string; userGroups: string[] }): Promise<BaseCatalog> => {
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
    };
  }

  const [tableRows, fieldRows, viewRows, formRows, documentTemplateRows] = await Promise.all([
    sql<DbRow[]>`
      SELECT t.* FROM grids.tables t
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE t.base_id = ${params.baseId}::uuid AND t.deleted_at IS NULL
      ORDER BY t.position, t.created_at
    `,
    sql<DbRow[]>`
      SELECT f.* FROM grids.fields f
      JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE t.base_id = ${params.baseId}::uuid AND f.deleted_at IS NULL
      ORDER BY f.table_id, f.position, f.created_at
    `,
    sql<DbRow[]>`
      SELECT v.* FROM grids.views v
      JOIN grids.tables t ON t.id = v.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE t.base_id = ${params.baseId}::uuid AND v.deleted_at IS NULL
      ORDER BY v.table_id, v.position, v.created_at
    `,
    sql<DbRow[]>`
      SELECT f.* FROM grids.forms f
      JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE t.base_id = ${params.baseId}::uuid AND f.deleted_at IS NULL
      ORDER BY f.table_id, f.position, f.created_at
    `,
    sql<DbRow[]>`
      SELECT dt.* FROM grids.document_templates dt
      JOIN grids.tables t ON t.id = dt.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE t.base_id = ${params.baseId}::uuid AND dt.deleted_at IS NULL
      ORDER BY dt.table_id, dt.position, dt.created_at
    `,
  ]);

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
  };
};
