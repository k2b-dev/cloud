import { err, fail, ok, type Result, crypto as stdCrypto } from "@k2b/stdlib";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { type Field, ViewUiSettingsSchema } from "../contracts";
import { customAppPageRecordFieldIds } from "../custom-apps/conditions";
import { customAppGlobalContextKeys } from "../custom-apps/context-keys";
import {
  type CustomAppBlock,
  type CustomAppCapabilities,
  CustomAppCapabilitiesSchema,
  type CustomAppDefinition,
  CustomAppDefinitionSchema,
  type CustomAppDiagnostic,
  parseStoredCustomAppDefinition,
} from "../custom-apps/contracts";
import { customAppDiagnostic } from "../custom-apps/diagnostics";
import {
  type CustomAppFormSecurityField,
  customAppFormFieldHash,
  customAppFormInlineTargetReferences,
  customAppFormSecurityHash,
} from "../custom-apps/form-capability";
import { customAppViewSourceHash } from "../custom-apps/insight-source";
import { customAppRecordsDisplayFieldHash } from "../custom-apps/records-display-capability";
import { referencedRecordsGqlSource } from "../custom-apps/referenced-records";
import { customAppScannerConfigHash } from "../custom-apps/scanner-capability";
import { stableCustomAppStringify } from "../custom-apps/stable-value";
import { customAppBindingRecordTableId } from "../custom-apps/value-bindings";
import { getRecordWritableFieldType, isRecordWritableFieldType } from "../field-types";
import type { DslQueryContextValues } from "../query-dsl/parameters";
import { isDslAggregateOnlyPlan } from "../query-dsl/resolver";
import { collectDslPlanTableIds } from "../query-dsl/source-plan";
import { scannerLauncherInputSources } from "../workflows/contracts";
import { logAudit, type SqlClient } from "./audit";
import { customAppMessagesFor } from "./custom-app-messages";
import { compileCustomAppQuery } from "./custom-app-query";
import { customAppRecordRelationSnapshot } from "./custom-app-record-relations";
import { listByTable as listFields, listByTables as listFieldsByTables } from "./fields";
import { normalizeFormConfig } from "./forms";
import { parseJsonbRow } from "./jsonb";
import { getLauncher } from "./workflow-launchers";
import { getWorkflow } from "./workflow-read";
import { workflowInputShapeError } from "./workflow-values";

type DbRow = Record<string, unknown>;

export type CustomApp = {
  id: string;
  shortId: string;
  baseId: string;
  name: string;
  icon: string | null;
  draftDefinition: CustomAppDefinition | null;
  draftDefinitionRaw: unknown;
  draftDiagnostics: CustomAppDiagnostic[];
  draftCapabilities: CustomAppCapabilities | null;
  publishedDefinition: CustomAppDefinition | null;
  publishedDefinitionRaw: unknown | null;
  publishedDiagnostics: CustomAppDiagnostic[];
  publishedCapabilities: CustomAppCapabilities | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  draftValid: boolean;
  publishedValid: boolean;
  hasUnpublishedChanges: boolean;
};

export type CustomAppSummary = Pick<
  CustomApp,
  "id" | "shortId" | "baseId" | "name" | "icon" | "publishedAt" | "updatedAt" | "draftValid" | "publishedValid" | "hasUnpublishedChanges"
>;

type CompiledCustomApp = {
  definition: CustomAppDefinition;
  capabilities: CustomAppCapabilities;
  bindings: { appId: string | null; baseId: string };
};
type CustomAppCompilation = { ok: true; compiled: CompiledCustomApp } | { ok: false; diagnostics: CustomAppDiagnostic[] };
export type CustomAppPlan = {
  valid: boolean;
  diagnostics: CustomAppDiagnostic[];
  action: "create" | "update" | "noop" | "invalid";
  changes: string[];
};

const parseStoredCapabilities = (raw: unknown): CustomAppCapabilities | null => {
  if (raw === null || raw === undefined) return null;
  const parsed = CustomAppCapabilitiesSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const mapRow = (row: DbRow): CustomApp => {
  const draftDefinitionRaw = parseJsonbRow(row.draft_definition, {});
  const publishedDefinitionRaw = row.published_definition ? parseJsonbRow(row.published_definition, {}) : null;
  const draft = parseStoredCustomAppDefinition(draftDefinitionRaw, "draft");
  const published = publishedDefinitionRaw ? parseStoredCustomAppDefinition(publishedDefinitionRaw, "published") : null;
  const draftCapabilities = parseStoredCapabilities(parseJsonbRow(row.draft_capabilities, null));
  const publishedCapabilities = parseStoredCapabilities(parseJsonbRow(row.published_capabilities, null));
  return {
    id: row.id as string,
    shortId: row.short_id as string,
    baseId: row.base_id as string,
    name: row.name as string,
    icon: (row.icon as string | null) ?? null,
    draftDefinition: draft.definition,
    draftDefinitionRaw,
    draftDiagnostics: draft.diagnostics,
    draftCapabilities,
    publishedDefinition: published?.definition ?? null,
    publishedDefinitionRaw,
    publishedDiagnostics: published?.diagnostics ?? [],
    publishedCapabilities,
    publishedAt: row.published_at ? (row.published_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    draftValid: draft.definition !== null && draftCapabilities !== null,
    publishedValid: published?.definition != null && publishedCapabilities !== null,
    hasUnpublishedChanges:
      publishedDefinitionRaw === null || stableCustomAppStringify(draftDefinitionRaw) !== stableCustomAppStringify(publishedDefinitionRaw),
  };
};

const mapSummaryRow = (row: DbRow): CustomAppSummary => ({
  id: row.id as string,
  shortId: row.short_id as string,
  baseId: row.base_id as string,
  name: row.name as string,
  icon: (row.icon as string | null) ?? null,
  publishedAt: row.published_at ? (row.published_at as Date).toISOString() : null,
  updatedAt: (row.updated_at as Date).toISOString(),
  draftValid:
    CustomAppDefinitionSchema.safeParse(parseJsonbRow(row.draft_definition, {})).success &&
    CustomAppCapabilitiesSchema.safeParse(parseJsonbRow(row.draft_capabilities, null)).success,
  publishedValid:
    row.published_definition != null &&
    CustomAppDefinitionSchema.safeParse(parseJsonbRow(row.published_definition, {})).success &&
    CustomAppCapabilitiesSchema.safeParse(parseJsonbRow(row.published_capabilities, null)).success,
  hasUnpublishedChanges:
    !row.published_definition ||
    stableCustomAppStringify(parseJsonbRow(row.draft_definition, {})) !==
      stableCustomAppStringify(parseJsonbRow(row.published_definition, {})),
});

const zodDiagnostics = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }, locale?: string): CustomAppDiagnostic[] =>
  error.issues.map((issue) =>
    customAppDiagnostic(
      locale,
      "schema.invalid",
      issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
      { detail: issue.message },
    ),
  );

const blocksByType = <T extends CustomAppBlock["type"]>(definition: CustomAppDefinition, type: T) =>
  definition.pages.flatMap((page) =>
    page.rows.flatMap((row) =>
      row.columns.flatMap((column) =>
        column.blocks
          .filter((block): block is Extract<(typeof column.blocks)[number], { type: T }> => block.type === type)
          .map((block) => ({ page, block })),
      ),
    ),
  );

const representativeQueryContext = (
  definition: CustomAppDefinition,
  page: CustomAppDefinition["pages"][number],
  baseName: string,
): DslQueryContextValues => ({
  "auth.id": "00000000-0000-4000-8000-000000000001",
  "auth.name": "Reader",
  "auth.username": "reader",
  "auth.email": "reader@example.test",
  "auth.subjects": ["00000000-0000-4000-8000-000000000001"],
  "page.id": page.id,
  "page.title": page.title,
  "page.url": `/app/grids/custom/draft/${page.id}`,
  "app.id": definition.id,
  "app.name": definition.name,
  "base.id": definition.baseId,
  "base.name": baseName,
  "time.now": "2000-01-01T00:00:00.000Z",
  "time.today": "2000-01-01",
  "time.timeZone": "UTC",
  ...Object.fromEntries(Object.keys(page.parameters).map((parameterId) => [`params.${parameterId}`, "REC001"])),
});

const representativeGlobalQueryContext = (definition: CustomAppDefinition, baseName: string): DslQueryContextValues => ({
  "auth.id": "00000000-0000-4000-8000-000000000001",
  "auth.name": "Reader",
  "auth.username": "reader",
  "auth.email": "reader@example.test",
  "auth.subjects": ["00000000-0000-4000-8000-000000000001"],
  "page.id": "global",
  "page.title": definition.name,
  "page.url": "/apps/draft",
  "app.id": definition.id,
  "app.name": definition.name,
  "base.id": definition.baseId,
  "base.name": baseName,
  "time.now": "2000-01-01T00:00:00.000Z",
  "time.today": "2000-01-01",
  "time.timeZone": "UTC",
});

export const compile = async (input: unknown, client: SqlClient = sql, locale?: string): Promise<CustomAppCompilation> => {
  const parsed = CustomAppDefinitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, diagnostics: zodDiagnostics(parsed.error, locale) };
  const definition = parsed.data;
  const [base] = await client<Array<{ id: string; short_id: string; name: string }>>`
    SELECT id, short_id, name FROM grids.bases WHERE short_id = ${definition.baseId} AND deleted_at IS NULL
  `;
  if (!base) return { ok: false, diagnostics: [customAppDiagnostic(locale, "base.missing", ["baseId"])] };
  const [existingApp] = await client<Array<{ id: string }>>`
    SELECT id FROM grids.custom_apps WHERE base_id = ${base.id}::uuid AND short_id = ${definition.id} AND deleted_at IS NULL
  `;
  const resourceRows = await client<
    Array<{ kind: "table" | "field" | "view" | "form" | "template" | "launcher"; short_id: string; id: string }>
  >`
    SELECT 'table' AS kind, t.short_id, t.id FROM grids.tables t
      WHERE t.base_id = ${base.id}::uuid AND t.deleted_at IS NULL
    UNION ALL
    SELECT 'field' AS kind, f.short_id, f.id FROM grids.fields f
      JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
      WHERE t.base_id = ${base.id}::uuid AND f.deleted_at IS NULL
    UNION ALL
    SELECT 'view' AS kind, v.short_id, v.id FROM grids.views v
      WHERE v.base_id = ${base.id}::uuid AND v.deleted_at IS NULL
    UNION ALL
    SELECT 'form' AS kind, f.short_id, f.id FROM grids.forms f
      JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
      WHERE t.base_id = ${base.id}::uuid AND f.deleted_at IS NULL
    UNION ALL
    SELECT 'template' AS kind, d.short_id, d.id FROM grids.document_templates d
      JOIN grids.tables t ON t.id = d.table_id AND t.deleted_at IS NULL
      WHERE t.base_id = ${base.id}::uuid AND d.deleted_at IS NULL
    UNION ALL
    SELECT 'launcher' AS kind, l.short_id, l.id FROM grids.workflow_launchers l
      WHERE l.base_id = ${base.id}::uuid AND l.deleted_at IS NULL
  `;
  const resources = new Map(resourceRows.map((row) => [`${row.kind}:${row.short_id}`, row.id]));
  const diagnostics: CustomAppDiagnostic[] = [];
  const checkReference = (kind: (typeof resourceRows)[number]["kind"], id: string, path: Array<string | number>): void => {
    if (!resources.has(`${kind}:${id}`))
      diagnostics.push(customAppDiagnostic(locale, "resource.missing", path, { kind: `${kind[0]!.toUpperCase()}${kind.slice(1)}` }));
  };
  for (const [pageIndex, page] of definition.pages.entries()) {
    for (const [parameterId, parameter] of Object.entries(page.parameters)) {
      checkReference("table", parameter.tableId, ["pages", pageIndex, "parameters", parameterId, "tableId"]);
    }
    if (page.record) checkReference("table", page.record.tableId, ["pages", pageIndex, "record", "tableId"]);
    for (const [rowIndex, row] of page.rows.entries()) {
      for (const [columnIndex, column] of row.columns.entries()) {
        for (const [blockIndex, block] of column.blocks.entries()) {
          const path = ["pages", pageIndex, "rows", rowIndex, "columns", columnIndex, "blocks", blockIndex] as Array<string | number>;
          if (block.type === "records") {
            if (block.source.kind === "view") checkReference("view", block.source.viewId, [...path, "source", "viewId"]);
            if (block.display.kind === "table")
              block.display.columnIds.forEach((id, index) => checkReference("field", id, [...path, "display", "columnIds", index]));
            for (const [actionIndex, action] of (block.rowActions ?? []).entries()) {
              checkReference("launcher", action.launcherId, [...path, "rowActions", actionIndex, "launcherId"]);
            }
            if (block.rowNavigate) {
              for (const [parameterId, binding] of Object.entries(block.rowNavigate.params)) {
                if (binding.path === "relation")
                  checkReference("field", binding.fieldId, [...path, "rowNavigate", "params", parameterId, "fieldId"]);
              }
            }
          } else if (block.type === "referenced_records") {
            checkReference("table", block.sourceTableId, [...path, "sourceTableId"]);
            checkReference("field", block.relationFieldId, [...path, "relationFieldId"]);
            block.fieldIds.forEach((id, index) => checkReference("field", id, [...path, "fieldIds", index]));
            for (const [actionIndex, action] of (block.rowActions ?? []).entries()) {
              checkReference("launcher", action.launcherId, [...path, "rowActions", actionIndex, "launcherId"]);
            }
          } else if (block.type === "metrics" || block.type === "chart") {
            if (block.source.kind === "view") checkReference("view", block.source.viewId, [...path, "source", "viewId"]);
          } else if (block.type === "record") {
            block.fieldIds.forEach((id, index) => checkReference("field", id, [...path, "fieldIds", index]));
            block.editableFieldIds.forEach((id, index) => checkReference("field", id, [...path, "editableFieldIds", index]));
            if (block.documents)
              block.documents.templateIds.forEach((id, index) =>
                checkReference("template", id, [...path, "documents", "templateIds", index]),
              );
          } else if (block.type === "html") {
            checkReference("field", block.fieldId, [...path, "fieldId"]);
          } else if (block.type === "form") {
            checkReference("form", block.formId, [...path, "formId"]);
            for (const id of Object.keys(block.fixedValues)) checkReference("field", id, [...path, "fixedValues", id]);
          } else if (block.type === "actions") {
            for (const [actionIndex, action] of block.actions.entries()) {
              if (action.kind === "workflow")
                checkReference("launcher", action.launcherId, [...path, "actions", actionIndex, "launcherId"]);
            }
          } else if (block.type === "scanner") {
            checkReference("launcher", block.launcherId, [...path, "launcherId"]);
          }
        }
      }
    }
  }
  for (const [actionIndex, action] of (definition.sidebar?.actions ?? []).entries()) {
    if (action.kind !== "form") continue;
    checkReference("form", action.formId, ["sidebar", "actions", actionIndex, "formId"]);
    for (const id of Object.keys(action.fixedValues)) checkReference("field", id, ["sidebar", "actions", actionIndex, "fixedValues", id]);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  // All public references are validated above. Only database identities enter capabilities and SQL.
  const resourceId = (kind: (typeof resourceRows)[number]["kind"], shortId: string): string => {
    const id = resources.get(`${kind}:${shortId}`);
    if (!id) throw new Error("Custom App reference was not validated");
    return id;
  };
  const fieldId = (shortId: string) => resourceId("field", shortId);
  const tableId = (shortId: string) => resourceId("table", shortId);
  const bindingTableId = (
    binding: Parameters<typeof customAppBindingRecordTableId>[0],
    page: CustomAppDefinition["pages"][number],
    rowTableId?: string,
  ): string | null => {
    if (binding.source === "ROW") return rowTableId ?? null;
    const publicTableId = customAppBindingRecordTableId(binding, page);
    return publicTableId ? tableId(publicTableId) : null;
  };
  const recordsBlocks = [...blocksByType(definition, "records"), ...blocksByType(definition, "referenced_records")];
  const insightBlocks = [...blocksByType(definition, "metrics"), ...blocksByType(definition, "chart")];
  const formBlocks = blocksByType(definition, "form");
  const sidebarFormActions = (definition.sidebar?.actions ?? []).filter((action) => action.kind === "form");
  const commentBlocks = blocksByType(definition, "comments");
  const actionBlocks = blocksByType(definition, "actions");
  const scannerBlocks = blocksByType(definition, "scanner");
  if (recordsBlocks.length > 24) {
    return { ok: false, diagnostics: [customAppDiagnostic(locale, "limit.records.total", ["pages"])] };
  }
  const crowdedRecordsPage = definition.pages.find((page) => recordsBlocks.filter((candidate) => candidate.page.id === page.id).length > 4);
  if (crowdedRecordsPage) {
    return {
      ok: false,
      diagnostics: [customAppDiagnostic(locale, "limit.records.page", ["pages", crowdedRecordsPage.id])],
    };
  }
  if (formBlocks.length + sidebarFormActions.length > 24) {
    return { ok: false, diagnostics: [customAppDiagnostic(locale, "limit.forms", ["pages"])] };
  }
  if (insightBlocks.length > 24) {
    return { ok: false, diagnostics: [customAppDiagnostic(locale, "limit.insights", ["pages"])] };
  }
  if (scannerBlocks.length > 24) {
    return { ok: false, diagnostics: [customAppDiagnostic(locale, "limit.scanners", ["pages"])] };
  }

  const availability: CustomAppCapabilities["availability"] = [];
  const views: CustomAppCapabilities["views"] = [];
  const insights: CustomAppCapabilities["insights"] = [];
  const recordQueries: CustomAppCapabilities["recordQueries"] = [];
  const pageRecords: CustomAppCapabilities["records"] = [];
  const forms: CustomAppCapabilities["forms"] = [];
  const comments: CustomAppCapabilities["comments"] = [];
  const documents: CustomAppCapabilities["documents"] = [];
  const workflowLaunchers: CustomAppCapabilities["workflowLaunchers"] = [];
  const scannerLaunchers: CustomAppCapabilities["scannerLaunchers"] = [];
  const recordsPrimaryTableIds = new Map<string, string>();
  const tableBaseIds = new Map<string, string | null>();
  const fieldsByTableId = new Map<string, Field[]>();
  const resolveTableBaseId = async (tableId: string): Promise<string | null> => {
    const cached = tableBaseIds.get(tableId);
    if (cached !== undefined) return cached;
    const [table] = await client<Array<{ base_id: string }>>`
      SELECT base_id FROM grids.tables WHERE id = ${tableId}::uuid AND deleted_at IS NULL
    `;
    const resolved = table?.base_id ?? null;
    tableBaseIds.set(tableId, resolved);
    return resolved;
  };
  const resolveFields = async (tableId: string): Promise<Field[]> => {
    const cached = fieldsByTableId.get(tableId);
    if (cached) return cached;
    const fields = await listFields(tableId, false, client);
    fieldsByTableId.set(tableId, fields);
    return fields;
  };

  const compileAvailabilityCapabilities = async (): Promise<CustomAppCompilation | null> => {
    const availabilitySources = [
      ...(definition.sidebar?.actions ?? []).flatMap((action) =>
        action.availableWhen
          ? [
              {
                page: undefined,
                query: action.availableWhen.query,
                target: { target: "sidebarAction" as const, actionId: action.id },
              },
            ]
          : [],
      ),
      ...definition.pages.flatMap((page) => [
        ...(page.availableWhen ? [{ page, query: page.availableWhen.query, target: { target: "page" as const, pageId: page.id } }] : []),
        ...page.rows.flatMap((row) =>
          row.columns.flatMap((column) =>
            column.blocks.flatMap((block) => [
              ...(block.availableWhen
                ? [
                    {
                      page,
                      query: block.availableWhen.query,
                      target: { target: "block" as const, pageId: page.id, blockId: block.id },
                    },
                  ]
                : []),
              ...(block.type === "actions"
                ? block.actions.flatMap((action) =>
                    action.availableWhen
                      ? [
                          {
                            page,
                            query: action.availableWhen.query,
                            target: {
                              target: "action" as const,
                              pageId: page.id,
                              blockId: block.id,
                              actionId: action.id,
                            },
                          },
                        ]
                      : [],
                  )
                : block.type === "records" || block.type === "referenced_records"
                  ? (block.rowActions ?? []).flatMap((action) =>
                      action.availableWhen
                        ? [
                            {
                              page,
                              query: action.availableWhen.query,
                              target: {
                                target: "action" as const,
                                pageId: page.id,
                                blockId: block.id,
                                actionId: action.id,
                              },
                            },
                          ]
                        : [],
                    )
                  : []),
            ]),
          ),
        ),
      ]),
    ];
    if (availabilitySources.length > 256) {
      return { ok: false, diagnostics: [customAppDiagnostic(locale, "limit.availability", ["pages"])] };
    }
    for (const source of availabilitySources) {
      const compiled = await compileCustomAppQuery({
        client,
        baseId: base.id,
        source: source.query,
        context: source.page
          ? representativeQueryContext(definition, source.page, base.name)
          : representativeGlobalQueryContext(definition, base.name),
        ...(source.page ? {} : { allowedContextKeys: customAppGlobalContextKeys() }),
      });
      const targetPath =
        source.target.target === "sidebarAction"
          ? ["sidebar", "actions", source.target.actionId, "availableWhen"]
          : [
              "pages",
              source.target.pageId,
              ...(source.target.target === "page" ? [] : ["blocks", source.target.blockId]),
              ...(source.target.target === "action" ? ["actions", source.target.actionId] : []),
              "availableWhen",
            ];
      if (!compiled.ok) {
        diagnostics.push(customAppDiagnostic(locale, "query.invalid", targetPath, { detail: compiled.error }));
        continue;
      }
      const tableIds = collectDslPlanTableIds(compiled.data.plan, compiled.data.fieldsByTableId).sort();
      if (tableIds.length > 24) {
        diagnostics.push(customAppDiagnostic(locale, "query.table_limit.availability", targetPath));
        continue;
      }
      availability.push({
        ...source.target,
        sourceHash: customAppViewSourceHash(base.id, source.query),
        planHash: compiled.data.planHash,
        tableIds,
      });
    }
    return null;
  };
  const availabilityFailure = await compileAvailabilityCapabilities();
  if (availabilityFailure) return availabilityFailure;

  const compilePageRecordCapabilities = async () => {
    for (const [pageIndex, page] of definition.pages.entries()) {
      for (const [parameterId, parameter] of Object.entries(page.parameters)) {
        if ((await resolveTableBaseId(tableId(parameter.tableId))) !== base.id) {
          diagnostics.push(
            customAppDiagnostic(locale, "record_parameter.table_invalid", ["pages", pageIndex, "parameters", parameterId, "tableId"]),
          );
        }
      }
      if (!page.record) continue;
      const recordBlocks = page.rows.flatMap((row) =>
        row.columns.flatMap((column) => column.blocks.filter((block) => block.type === "record")),
      );
      const recordFieldIds = new Set(recordBlocks.flatMap((block) => block.fieldIds.map(fieldId)));
      const fieldIds = customAppPageRecordFieldIds(page).map(fieldId).sort();
      const editableFieldIds = [...new Set(recordBlocks.flatMap((block) => block.editableFieldIds.map(fieldId)))].sort();
      if ((await resolveTableBaseId(tableId(page.record.tableId))) !== base.id) {
        diagnostics.push(customAppDiagnostic(locale, "record_page.table_invalid", ["pages", pageIndex, "record", "tableId"]));
        continue;
      }
      let relationLabels: CustomAppCapabilities["records"][number]["relationLabels"] = [];
      if (fieldIds.length > 0) {
        const fields = (await resolveFields(tableId(page.record.tableId))).filter((field) => fieldIds.includes(field.id));
        const found = new Set(fields.map((field) => field.id));
        const fieldsById = new Map(fields.map((field) => [field.id, field]));
        for (const fieldId of fieldIds) {
          if (!found.has(fieldId) && recordFieldIds.has(fieldId)) {
            diagnostics.push(customAppDiagnostic(locale, "field.missing", ["pages", pageIndex, "record", "fieldIds"], { fieldId }));
          }
        }
        for (const fieldId of editableFieldIds) {
          const field = fieldsById.get(fieldId);
          if (field && !isRecordWritableFieldType(field.type) && field.type !== "file") {
            diagnostics.push(
              customAppDiagnostic(locale, "field.not_writable", ["pages", pageIndex, "record", "editableFieldIds"], { fieldId }),
            );
          }
        }
        for (const [rowIndex, row] of page.rows.entries()) {
          for (const [columnIndex, column] of row.columns.entries()) {
            for (const [blockIndex, block] of column.blocks.entries()) {
              if (block.type !== "html") continue;
              const field = fieldsById.get(fieldId(block.fieldId));
              if (!field || field.type !== "html_template") {
                diagnostics.push(
                  customAppDiagnostic(
                    locale,
                    field ? "html_field.type" : "html_field.missing",
                    ["pages", pageIndex, "rows", rowIndex, "columns", columnIndex, "blocks", blockIndex, "fieldId"],
                    { fieldId: block.fieldId },
                  ),
                );
              }
            }
          }
        }
        const targetTableIds = [
          ...new Set(
            fields.flatMap((field) => {
              if (field.type !== "relation") return [];
              const targetTableId = (field.config as { targetTableId?: unknown }).targetTableId;
              return typeof targetTableId === "string" ? [targetTableId] : [];
            }),
          ),
        ];
        const targetFieldsByTableId = new Map<string, Field[]>();
        for (const targetTableId of targetTableIds) {
          if ((await resolveTableBaseId(targetTableId)) !== base.id) {
            diagnostics.push(
              customAppDiagnostic(locale, "relation_target.table_invalid", ["pages", pageIndex, "record", "fieldIds"], {
                tableId: targetTableId,
              }),
            );
            continue;
          }
          targetFieldsByTableId.set(targetTableId, await resolveFields(targetTableId));
        }
        relationLabels = customAppRecordRelationSnapshot(fields, targetFieldsByTableId);
      }
      pageRecords.push({ pageId: page.id, tableId: tableId(page.record.tableId), fieldIds, editableFieldIds, relationLabels });
      for (const { block } of commentBlocks.filter((candidate) => candidate.page.id === page.id)) {
        comments.push({ pageId: page.id, blockId: block.id, tableId: tableId(page.record.tableId) });
      }
      const pageTemplateIds = [
        ...new Set(recordBlocks.flatMap((block) => (block.documents?.templateIds ?? []).map((id) => resourceId("template", id)))),
      ].sort();
      const pageTemplates =
        pageTemplateIds.length === 0
          ? []
          : await client<Array<{ id: string; table_id: string }>>`
            SELECT id, table_id
            FROM grids.document_templates
            WHERE deleted_at IS NULL AND id = ANY(${toPgUuidArray(pageTemplateIds)}::uuid[])
          `;
      const templatesById = new Map(pageTemplates.map((template) => [template.id, template]));
      for (const block of recordBlocks) {
        const templateIds = (block.documents?.templateIds ?? []).map((id) => resourceId("template", id)).sort();
        if (templateIds.length === 0) continue;
        for (const templateId of templateIds) {
          const template = templatesById.get(templateId);
          if (!template || template.table_id !== tableId(page.record.tableId)) {
            diagnostics.push(
              customAppDiagnostic(locale, "document_template.invalid", ["pages", page.id, "blocks", block.id, "documents", "templateIds"], {
                templateId,
              }),
            );
          }
        }
        documents.push({ pageId: page.id, blockId: block.id, tableId: tableId(page.record.tableId), templateIds });
      }
    }
  };
  await compilePageRecordCapabilities();

  const compileRecordsSourceCapabilities = async () => {
    for (const { page, block } of recordsBlocks) {
      if (block.type === "referenced_records") {
        if (!page.record) {
          diagnostics.push(
            customAppDiagnostic(locale, "referenced_records.record_page_required", ["pages", page.id, "blocks", block.id, "type"]),
          );
          continue;
        }
        const sourceFields = await resolveFields(tableId(block.sourceTableId));
        const relationField = sourceFields.find((field) => field.id === fieldId(block.relationFieldId) && !field.deletedAt);
        const relationConfig = relationField?.config as { targetTableId?: unknown } | undefined;
        if (relationField?.type !== "relation" || relationConfig?.targetTableId !== tableId(page.record.tableId)) {
          diagnostics.push(
            customAppDiagnostic(locale, "referenced_records.relation_invalid", ["pages", page.id, "blocks", block.id, "relationFieldId"]),
          );
          continue;
        }
        const sourceFieldIds = new Set(sourceFields.filter((field) => !field.deletedAt).map((field) => field.id));
        if (block.fieldIds.some((id) => !sourceFieldIds.has(fieldId(id)))) {
          diagnostics.push(
            customAppDiagnostic(locale, "referenced_records.fields_invalid", ["pages", page.id, "blocks", block.id, "fieldIds"]),
          );
          continue;
        }
      }
      const referencedSource = block.type === "referenced_records" ? referencedRecordsGqlSource(page, block) : null;
      const source =
        block.type === "referenced_records"
          ? { kind: "gql" as const, query: referencedSource ?? "" }
          : block.source.kind === "view"
            ? await client<Array<{ view_id: string; table_id: string; base_id: string; source: string; ui: unknown }>>`
            SELECT v.id AS view_id, v.table_id, t.base_id, v.source, v.ui
            FROM grids.views v
            JOIN grids.tables t ON t.id = v.table_id AND t.deleted_at IS NULL
            WHERE v.id = ${resourceId("view", block.source.viewId)}::uuid AND v.deleted_at IS NULL
          `.then(([view]) => {
                if (!view || view.base_id !== base.id) return null;
                const ui = ViewUiSettingsSchema.safeParse(parseJsonbRow(view.ui, {}));
                return {
                  kind: "view" as const,
                  query: view.source,
                  currentTableId: view.table_id,
                  viewId: view.view_id,
                  ui: ui.success ? ui.data : {},
                };
              })
            : { kind: "gql" as const, query: block.source.query };
      if (!source) {
        diagnostics.push(customAppDiagnostic(locale, "view.invalid", ["blocks", block.id, "source", "viewId"]));
        continue;
      }
      const compiled = await compileCustomAppQuery({
        client,
        baseId: base.id,
        source: source.query,
        context: representativeQueryContext(definition, page, base.name),
        ...(source.kind === "view" ? { currentTableId: source.currentTableId } : {}),
      });
      if (!compiled.ok) {
        diagnostics.push(
          customAppDiagnostic(locale, "query.invalid", ["pages", page.id, "blocks", block.id, "source"], { detail: compiled.error }),
        );
        continue;
      }
      const plan = compiled.data.plan;
      const aggregationCount =
        (plan.query.aggregations?.length ?? 0) + (plan.sqlAggregations?.length ?? 0) + (plan.formulaAggregations?.length ?? 0);
      const groupCount = (plan.query.groupBy?.length ?? 0) + (plan.sqlGroupBy?.length ?? 0);
      if (aggregationCount > 0 || groupCount > 0) {
        diagnostics.push(customAppDiagnostic(locale, "records.aggregate_source", ["pages", page.id, "blocks", block.id, "source"]));
        continue;
      }
      const tableIds = collectDslPlanTableIds(plan, compiled.data.fieldsByTableId).sort();
      if (tableIds.length > 24) {
        diagnostics.push(customAppDiagnostic(locale, "query.table_limit.records", ["pages", page.id, "blocks", block.id, "source"]));
        continue;
      }
      const primaryTableId = plan.tableId;
      recordsPrimaryTableIds.set(`${page.id}\0${block.id}`, primaryTableId);
      if (block.type === "records" && block.rowNavigate) {
        const targetPage = definition.pages.find((candidate) => candidate.id === block.rowNavigate!.pageId)!;
        const primaryFields = await resolveFields(primaryTableId);
        const selectedFieldIds = plan.outputColumns?.flatMap((column) => (column.kind === "field" ? [column.fieldId] : []));
        for (const [parameterId, binding] of Object.entries(block.rowNavigate.params)) {
          const targetTable = targetPage.parameters[parameterId]?.tableId;
          const targetTableId = targetTable ? tableId(targetTable) : null;
          if (binding.path === "id" && targetTableId !== primaryTableId) {
            diagnostics.push(
              customAppDiagnostic(locale, "navigation.record_table_mismatch", [
                "pages",
                page.id,
                "blocks",
                block.id,
                "rowNavigate",
                "params",
                parameterId,
              ]),
            );
            continue;
          }
          if (binding.path !== "relation") continue;
          const field = primaryFields.find((candidate) => candidate.id === fieldId(binding.fieldId) && !candidate.deletedAt);
          const config = field?.config as { cardinality?: unknown; targetTableId?: unknown } | undefined;
          if (
            field?.type !== "relation" ||
            config?.cardinality !== "single" ||
            config.targetTableId !== targetTableId ||
            (selectedFieldIds && !selectedFieldIds.includes(field.id))
          ) {
            diagnostics.push(
              customAppDiagnostic(locale, "navigation.relation_invalid", [
                "pages",
                page.id,
                "blocks",
                block.id,
                "rowNavigate",
                "params",
                parameterId,
              ]),
            );
          }
        }
      }
      if (source.kind === "view" && block.type === "records") {
        const found = new Set(tableIds.flatMap((tableId) => (compiled.data.fieldsByTableId[tableId] ?? []).map((field) => field.id)));
        for (const id of block.display.kind === "table" ? block.display.columnIds : []) {
          if (!found.has(fieldId(id)))
            diagnostics.push(customAppDiagnostic(locale, "field.missing", ["blocks", block.id, "display", "columnIds"], { fieldId: id }));
        }
        const primaryFields = compiled.data.fieldsByTableId[source.currentTableId] ?? [];
        const viewDisplayConfig = block.display.kind === "cards" ? source.ui.displayConfig : undefined;
        if (block.display.kind === "cards" && viewDisplayConfig?.mode !== "cards") {
          diagnostics.push(customAppDiagnostic(locale, "cards.view_required", ["pages", page.id, "blocks", block.id, "display"]));
        }
        const configuredCardFieldIds = viewDisplayConfig?.cards?.fieldIds ?? [];
        const resolvedCardFieldIds =
          configuredCardFieldIds.length > 0
            ? configuredCardFieldIds
            : primaryFields
                .filter((field) => !field.deletedAt && !field.hideInTable && field.type !== "file")
                .sort((left, right) => left.position - right.position)
                .slice(0, 4)
                .map((field) => field.id);
        const displayConfig = viewDisplayConfig
          ? { ...viewDisplayConfig, cards: { ...viewDisplayConfig.cards, fieldIds: resolvedCardFieldIds } }
          : undefined;
        const displayFieldIds = [
          ...(displayConfig?.cards?.fieldIds ?? []),
          ...(displayConfig?.cards?.imageFieldId ? [displayConfig.cards.imageFieldId] : []),
        ];
        const primaryFieldsById = new Map(primaryFields.map((field) => [field.id, field]));
        for (const fieldId of displayFieldIds) {
          const field = primaryFieldsById.get(fieldId);
          if (!field || field.deletedAt) {
            diagnostics.push(
              customAppDiagnostic(locale, "cards.field_unavailable", ["pages", page.id, "blocks", block.id, "display"], { fieldId }),
            );
          }
        }
        if (displayConfig?.cards?.imageFieldId && primaryFieldsById.get(displayConfig.cards.imageFieldId)?.type !== "file") {
          diagnostics.push(customAppDiagnostic(locale, "cards.cover_file_required", ["pages", page.id, "blocks", block.id, "display"]));
        }
        const cardFields = displayFieldIds.flatMap((fieldId) => {
          const field = primaryFieldsById.get(fieldId);
          return field ? [field] : [];
        });
        const relationTargetTableIds = [
          ...new Set(
            cardFields.flatMap((field) => {
              const targetTableId = field.type === "relation" ? (field.config as { targetTableId?: unknown }).targetTableId : null;
              return typeof targetTableId === "string" ? [targetTableId] : [];
            }),
          ),
        ];
        const relationLabels = customAppRecordRelationSnapshot(cardFields, await listFieldsByTables(relationTargetTableIds));
        views.push({
          viewId: source.viewId,
          tableId: primaryTableId,
          sourceHash: customAppViewSourceHash(source.currentTableId, source.query),
          planHash: compiled.data.planHash,
          tableIds,
          ...(displayConfig
            ? { displayConfig, displayFieldHash: customAppRecordsDisplayFieldHash(displayConfig, primaryFields), relationLabels }
            : {}),
        });
      } else {
        if (block.type === "records" && block.display.kind === "table" && block.display.columnIds.length > 0) {
          const outputFieldIds =
            plan.outputColumns && plan.outputColumns.length > 0
              ? new Set(plan.outputColumns.flatMap((column) => (column.kind === "computed" ? [] : [column.fieldId])))
              : new Set((compiled.data.fieldsByTableId[primaryTableId] ?? []).filter((field) => !field.deletedAt).map((field) => field.id));
          for (const id of block.display.columnIds) {
            if (!outputFieldIds.has(fieldId(id))) {
              diagnostics.push(
                customAppDiagnostic(locale, "records.field_not_selected", ["pages", page.id, "blocks", block.id, "display", "columnIds"], {
                  fieldId: id,
                }),
              );
            }
          }
        }
        if (block.type === "referenced_records" && primaryTableId !== tableId(block.sourceTableId)) {
          diagnostics.push(
            customAppDiagnostic(locale, "referenced_records.source_mismatch", ["pages", page.id, "blocks", block.id, "sourceTableId"]),
          );
          continue;
        }
        const relationLabels =
          block.type === "referenced_records"
            ? (() => {
                const selectedFieldIds = new Set(block.fieldIds.map(fieldId));
                const selected = (compiled.data.fieldsByTableId[primaryTableId] ?? []).filter((field) => selectedFieldIds.has(field.id));
                const targetTableIds = [
                  ...new Set(
                    selected.flatMap((field) => {
                      const targetTableId = field.type === "relation" ? (field.config as { targetTableId?: unknown }).targetTableId : null;
                      return typeof targetTableId === "string" ? [targetTableId] : [];
                    }),
                  ),
                ];
                return { selected, targetTableIds };
              })()
            : null;
        recordQueries.push({
          pageId: page.id,
          blockId: block.id,
          primaryTableId,
          planHash: compiled.data.planHash,
          tableIds,
          ...(relationLabels
            ? {
                relationLabels: customAppRecordRelationSnapshot(
                  relationLabels.selected,
                  await listFieldsByTables(relationLabels.targetTableIds),
                ),
              }
            : {}),
        });
      }
    }
  };
  await compileRecordsSourceCapabilities();

  const compileInsightCapabilities = async () => {
    for (const { page, block } of insightBlocks) {
      const source =
        block.source.kind === "view"
          ? await client<Array<{ view_id: string; table_id: string; base_id: string; source: string }>>`
            SELECT v.id AS view_id, v.table_id, t.base_id, v.source
            FROM grids.views v
            JOIN grids.tables t ON t.id = v.table_id AND t.deleted_at IS NULL
            WHERE v.id = ${resourceId("view", block.source.viewId)}::uuid AND v.deleted_at IS NULL
          `.then(([view]) =>
              !view || view.base_id !== base.id
                ? null
                : { kind: "view" as const, query: view.source, currentTableId: view.table_id, viewId: view.view_id },
            )
          : { kind: "gql" as const, query: block.source.query };
      if (!source) {
        diagnostics.push(customAppDiagnostic(locale, "view.invalid", ["pages", page.id, "blocks", block.id, "source", "viewId"]));
        continue;
      }
      const compiled = await compileCustomAppQuery({
        client,
        baseId: base.id,
        source: source.query,
        context: representativeQueryContext(definition, page, base.name),
        ...(source.kind === "view" ? { currentTableId: source.currentTableId } : {}),
      });
      if (!compiled.ok) {
        diagnostics.push(
          customAppDiagnostic(locale, "query.invalid", ["pages", page.id, "blocks", block.id, "source"], { detail: compiled.error }),
        );
        continue;
      }
      const plan = compiled.data.plan;
      const aggregationCount =
        (plan.query.aggregations?.length ?? 0) + (plan.sqlAggregations?.length ?? 0) + (plan.formulaAggregations?.length ?? 0);
      const groupCount = (plan.query.groupBy?.length ?? 0) + (plan.sqlGroupBy?.length ?? 0);
      if (block.type === "metrics") {
        if (!isDslAggregateOnlyPlan(plan)) {
          diagnostics.push(customAppDiagnostic(locale, "metrics.aggregate_required", ["pages", page.id, "blocks", block.id, "source"]));
          continue;
        }
        if (aggregationCount > 12) {
          diagnostics.push(customAppDiagnostic(locale, "metrics.aggregation_limit", ["pages", page.id, "blocks", block.id, "source"]));
          continue;
        }
      } else {
        if (groupCount === 0 || aggregationCount < 1) {
          diagnostics.push(customAppDiagnostic(locale, "chart.group_required", ["pages", page.id, "blocks", block.id, "source"]));
          continue;
        }
      }
      const tableIds = collectDslPlanTableIds(plan, compiled.data.fieldsByTableId).sort();
      if (tableIds.length > 24) {
        diagnostics.push(customAppDiagnostic(locale, "query.table_limit.insights", ["pages", page.id, "blocks", block.id, "source"]));
        continue;
      }
      insights.push({
        pageId: page.id,
        blockId: block.id,
        blockType: block.type,
        source:
          source.kind === "view"
            ? {
                kind: "view",
                viewId: source.viewId,
                sourceHash: customAppViewSourceHash(source.currentTableId, source.query),
                planHash: compiled.data.planHash,
                tableIds,
              }
            : { kind: "gql", planHash: compiled.data.planHash, tableIds },
      });
    }
  };
  await compileInsightCapabilities();

  const compileFormCapabilities = async () => {
    const formOwners = [
      ...formBlocks.map(({ page, block }) => ({
        page,
        block,
        formPath: ["pages", page.id, "blocks", block.id] as Array<string | number>,
        capabilityIdentity: { pageId: page.id, blockId: block.id },
      })),
      ...sidebarFormActions.map((block) => ({
        page: undefined,
        block,
        formPath: ["sidebar", "actions", block.id] as Array<string | number>,
        capabilityIdentity: { sidebarActionId: block.id },
      })),
    ];
    for (const { page, block, formPath, capabilityIdentity } of formOwners) {
      const [formRow] = await client<Array<{ table_id: string; base_id: string; config: unknown; is_active: boolean }>>`
      SELECT f.table_id, t.base_id, f.config, f.is_active
      FROM grids.forms f
      JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
      WHERE f.id = ${resourceId("form", block.formId)}::uuid AND f.deleted_at IS NULL
    `;
      if (!formRow || formRow.base_id !== base.id || !formRow.is_active) {
        diagnostics.push(customAppDiagnostic(locale, "form.invalid", [...formPath, "formId"]));
        continue;
      }

      const config = normalizeFormConfig(formRow.config);
      const userInputFieldIds = config.fields
        .filter((entry) => entry.kind === "user_input")
        .map((entry) => entry.fieldId)
        .sort();
      const userInputFieldIdSet = new Set(userInputFieldIds);
      const fixedFieldIds = Object.keys(block.fixedValues).map(fieldId).sort();
      if (userInputFieldIds.length > 100) {
        diagnostics.push(customAppDiagnostic(locale, "form.input_limit", [...formPath, "formId"]));
        continue;
      }
      if (fixedFieldIds.length > 30) {
        diagnostics.push(customAppDiagnostic(locale, "form.fixed_limit", [...formPath, "fixedValues"]));
        continue;
      }
      const fieldIds = [...new Set([...userInputFieldIds, ...fixedFieldIds])];
      const formFieldIds = [...new Set(config.fields.map((entry) => entry.fieldId))];
      const fields =
        formFieldIds.length === 0
          ? []
          : await client<
              Array<{
                id: string;
                table_id: string;
                type: string;
                config: unknown;
                required: boolean;
                default_value: unknown;
                deleted_at: Date | null;
              }>
            >`
            SELECT id, table_id, type, config, required, default_value, deleted_at
            FROM grids.fields
            WHERE table_id = ${formRow.table_id}::uuid
              AND id = ANY(${toPgUuidArray(formFieldIds)}::uuid[])
          `;
      const capabilityFields: CustomAppFormSecurityField[] = fields.map((field) => ({
        id: field.id,
        tableId: field.table_id,
        type: field.type,
        config: field.config,
        required: field.required,
        defaultValue: parseJsonbRow<unknown>(field.default_value, null),
        deletedAt: field.deleted_at?.toISOString() ?? null,
      }));
      const fieldsById = new Map(capabilityFields.map((field) => [field.id, field]));
      for (const fieldId of formFieldIds) {
        const field = fieldsById.get(fieldId);
        if (!field || field.deletedAt || !isRecordWritableFieldType(field.type)) {
          diagnostics.push(customAppDiagnostic(locale, "form.field_invalid", [...formPath, "formId"], { fieldId }));
        }
      }
      for (const entry of config.fields) {
        if (entry.kind !== "user_input" || !entry.inlineCreate?.enabled) continue;
        const field = fieldsById.get(entry.fieldId);
        const targetTableId =
          field?.type === "relation" && field.config && typeof field.config === "object"
            ? (field.config as { targetTableId?: unknown }).targetTableId
            : null;
        if (typeof targetTableId !== "string" || (entry.inlineCreate.fields ?? []).length === 0) {
          diagnostics.push(
            customAppDiagnostic(locale, "form.inline_create_config_invalid", [...formPath, "formId"], { fieldId: entry.fieldId }),
          );
        }
      }
      const inlineTargetReferences = customAppFormInlineTargetReferences(config, capabilityFields);
      const inlineTargetFieldIds = [...new Set(inlineTargetReferences.map((reference) => reference.fieldId))];
      const inlineTargetFields =
        inlineTargetFieldIds.length === 0
          ? []
          : await client<
              Array<{
                id: string;
                table_id: string;
                type: string;
                config: unknown;
                required: boolean;
                default_value: unknown;
                deleted_at: Date | null;
              }>
            >`
            SELECT f.id, f.table_id, f.type, f.config, f.required, f.default_value, f.deleted_at
            FROM grids.fields f
            JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
            JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
            WHERE f.id = ANY(${toPgUuidArray(inlineTargetFieldIds)}::uuid[])
          `;
      const inlineCapabilityFields: CustomAppFormSecurityField[] = inlineTargetFields.map((field) => ({
        id: field.id,
        tableId: field.table_id,
        type: field.type,
        config: field.config,
        required: field.required,
        defaultValue: parseJsonbRow<unknown>(field.default_value, null),
        deletedAt: field.deleted_at?.toISOString() ?? null,
      }));
      const inlineFieldsByKey = new Map(inlineCapabilityFields.map((field) => [`${field.tableId}\0${field.id}`, field]));
      for (const reference of inlineTargetReferences) {
        const field = inlineFieldsByKey.get(`${reference.tableId}\0${reference.fieldId}`);
        if (!field || field.deletedAt || !isRecordWritableFieldType(field.type) || field.type === "relation") {
          diagnostics.push(
            customAppDiagnostic(locale, "form.inline_create_field_invalid", [...formPath, "formId"], { fieldId: reference.fieldId }),
          );
        }
      }
      for (const [publicFieldId, value] of Object.entries(block.fixedValues)) {
        const resolvedFieldId = fieldId(publicFieldId);
        const field = fieldsById.get(resolvedFieldId);
        if (!userInputFieldIdSet.has(resolvedFieldId)) {
          diagnostics.push(customAppDiagnostic(locale, "form.fixed_target_invalid", [...formPath, "fixedValues", publicFieldId]));
          continue;
        }
        if (!field) continue;
        if (value.source === "AUTH") {
          if (field.type !== "principal") {
            diagnostics.push(customAppDiagnostic(locale, "form.current_user_target_invalid", [...formPath, "fixedValues", publicFieldId]));
          }
          continue;
        }
        if (value.source === "LITERAL") {
          const handler = getRecordWritableFieldType(field.type);
          const normalized = handler?.validate(value.value, field.config, field.required);
          if (!normalized?.ok || normalized.value === undefined) {
            diagnostics.push(
              customAppDiagnostic(locale, "form.fixed_value_invalid", [...formPath, "fixedValues", publicFieldId, "value"], {
                fieldId: publicFieldId,
              }),
            );
          }
          continue;
        }
        const fieldConfig = parseJsonbRow<{ targetTableId?: unknown }>(field?.config, {});
        if (field?.type !== "relation" || typeof fieldConfig.targetTableId !== "string") {
          diagnostics.push(customAppDiagnostic(locale, "form.record_relation_required", [...formPath, "fixedValues", publicFieldId]));
        } else if (!page || fieldConfig.targetTableId !== bindingTableId(value, page)) {
          diagnostics.push(customAppDiagnostic(locale, "form.record_relation_mismatch", [...formPath, "fixedValues", publicFieldId]));
        }
      }

      if (block.onSuccessNavigate) {
        const targetPage = definition.pages.find((candidate) => candidate.id === block.onSuccessNavigate!.pageId)!;
        for (const [parameterId, value] of Object.entries(block.onSuccessNavigate.params)) {
          if (value.source === "RESULT" && tableId(targetPage.parameters[parameterId]!.tableId) !== formRow.table_id) {
            diagnostics.push(
              customAppDiagnostic(locale, "form.result_navigation_mismatch", [...formPath, "onSuccessNavigate", "params", parameterId]),
            );
          }
        }
      }

      forms.push({
        ...capabilityIdentity,
        formId: resourceId("form", block.formId),
        tableId: formRow.table_id,
        userInputFieldIds,
        fixedFieldIds,
        fieldHash: customAppFormFieldHash(fieldIds, capabilityFields),
        formSecurityHash: customAppFormSecurityHash({
          tableId: formRow.table_id,
          config,
          fields: [...capabilityFields, ...inlineCapabilityFields],
        }),
      });
    }
  };
  await compileFormCapabilities();

  const compileWorkflowCapabilities = async () => {
    const workflowActionOwners = [
      ...actionBlocks.flatMap(({ page, block }) =>
        block.actions
          .filter((action) => action.kind === "workflow")
          .map((action) => ({
            page,
            action,
            actionPath: ["pages", page.id, "blocks", block.id, "actions", action.id] as Array<string | number>,
            capabilityIdentity: { pageId: page.id, blockId: block.id, actionId: action.id },
            rowTableId: undefined,
          })),
      ),
      ...recordsBlocks.flatMap(({ page, block }) =>
        (block.rowActions ?? []).map((action) => ({
          page,
          action,
          actionPath: ["pages", page.id, "blocks", block.id, "rowActions", action.id] as Array<string | number>,
          capabilityIdentity: { pageId: page.id, blockId: block.id, actionId: action.id },
          rowTableId: recordsPrimaryTableIds.get(`${page.id}\0${block.id}`),
        })),
      ),
    ];
    for (const { page, action, actionPath, capabilityIdentity, rowTableId } of workflowActionOwners) {
      const launcher = await getLauncher(resourceId("launcher", action.launcherId), client);
      if (
        !launcher ||
        launcher.baseId !== base.id ||
        launcher.deletedAt !== null ||
        !launcher.enabled ||
        launcher.diagnostics.some((item) => item.severity === "error") ||
        launcher.config.kind !== "customApp"
      ) {
        diagnostics.push(customAppDiagnostic(locale, "workflow_launcher.invalid", [...actionPath, "launcherId"]));
        continue;
      }
      const workflow = await getWorkflow(launcher.workflowId, false, client);
      if (
        !workflow ||
        workflow.baseId !== base.id ||
        workflow.deletedAt !== null ||
        !workflow.enabled ||
        workflow.revision !== launcher.validatedRevision ||
        workflow.diagnostics.some((item) => item.severity === "error")
      ) {
        diagnostics.push(customAppDiagnostic(locale, "workflow_launcher.revision_invalid", [...actionPath, "launcherId"]));
        continue;
      }
      if (launcher.config.inputMode === "fixed" && Object.keys(action.inputs).length > 0) {
        diagnostics.push(customAppDiagnostic(locale, "workflow_launcher.fixed_inputs", [...actionPath, "inputs"]));
        continue;
      }
      if (launcher.config.inputMode === "prompt") {
        const inputsByName = new Map(workflow.plan.inputs.map((input) => [input.name, input]));
        for (const inputName of Object.keys(action.inputs)) {
          if (!inputsByName.has(inputName)) {
            diagnostics.push(
              customAppDiagnostic(locale, "workflow_input.unknown", [...actionPath, "inputs", inputName], { name: inputName }),
            );
          }
        }
        for (const input of workflow.plan.inputs) {
          const value = action.inputs[input.name];
          if (!value) {
            const message = workflowInputShapeError(input, undefined);
            if (message) {
              diagnostics.push(
                customAppDiagnostic(locale, "workflow_input.invalid", [...actionPath, "inputs", input.name], { name: input.name }),
              );
            }
            continue;
          }
          if (value.source === "LITERAL") {
            const message = workflowInputShapeError(input, value.value);
            if (message) {
              diagnostics.push(
                customAppDiagnostic(locale, "workflow_input.invalid", [...actionPath, "inputs", input.name], { name: input.name }),
              );
            }
            continue;
          }
          const sourceTableId = page ? bindingTableId(value, page, rowTableId) : null;
          const boundTableId = workflow.plan.bindings[`inputs.${input.name}.table`];
          if (input.type !== "record" || typeof boundTableId !== "string" || sourceTableId !== boundTableId) {
            diagnostics.push(
              customAppDiagnostic(locale, "workflow_input.record_binding_invalid", [...actionPath, "inputs", input.name], {
                name: input.name,
              }),
            );
          }
        }
      }
      workflowLaunchers.push({
        ...capabilityIdentity,
        launcherId: launcher.id,
        workflowId: workflow.id,
        revision: workflow.revision,
      });
    }
  };
  await compileWorkflowCapabilities();

  const compileScannerCapabilities = async () => {
    for (const { page, block } of scannerBlocks) {
      const launcher = await getLauncher(resourceId("launcher", block.launcherId), client);
      if (
        !launcher ||
        launcher.baseId !== base.id ||
        launcher.deletedAt !== null ||
        !launcher.enabled ||
        launcher.diagnostics.some((item) => item.severity === "error") ||
        launcher.config.kind !== "scanner"
      ) {
        diagnostics.push(customAppDiagnostic(locale, "scanner_launcher.invalid", ["pages", page.id, "blocks", block.id, "launcherId"]));
        continue;
      }
      const workflow = await getWorkflow(launcher.workflowId, false, client);
      if (
        !workflow ||
        workflow.baseId !== base.id ||
        workflow.deletedAt !== null ||
        !workflow.enabled ||
        workflow.revision !== launcher.validatedRevision ||
        workflow.diagnostics.some((item) => item.severity === "error")
      ) {
        diagnostics.push(
          customAppDiagnostic(locale, "scanner_launcher.revision_invalid", ["pages", page.id, "blocks", block.id, "launcherId"]),
        );
        continue;
      }
      const sources = scannerLauncherInputSources(launcher.config);
      const promptRecordInput = workflow.plan.inputs.find((input) => {
        const source = sources[input.name];
        return (source?.kind === "session" || source?.kind === "afterScan") && (input.type === "record" || input.type === "recordList");
      });
      if (promptRecordInput) {
        diagnostics.push(
          customAppDiagnostic(locale, "scanner_launcher.record_prompt", ["pages", page.id, "blocks", block.id, "launcherId"], {
            name: promptRecordInput.name,
          }),
        );
        continue;
      }
      scannerLaunchers.push({
        pageId: page.id,
        blockId: block.id,
        launcherId: launcher.id,
        workflowId: workflow.id,
        revision: workflow.revision,
        configHash: customAppScannerConfigHash(launcher.config),
      });
    }
  };
  await compileScannerCapabilities();
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const viewsById = new Map<string, CustomAppCapabilities["views"][number]>();
  for (const view of views) {
    const existing = viewsById.get(view.viewId);
    viewsById.set(
      view.viewId,
      view.displayConfig || !existing || !existing.displayConfig
        ? view
        : {
            ...view,
            displayConfig: existing.displayConfig,
            displayFieldHash: existing.displayFieldHash,
            relationLabels: existing.relationLabels,
          },
    );
  }

  const capabilities = CustomAppCapabilitiesSchema.parse({
    availability: availability.sort(
      (left, right) =>
        ("pageId" in left ? left.pageId : "").localeCompare("pageId" in right ? right.pageId : "") ||
        ("blockId" in left ? left.blockId : "").localeCompare("blockId" in right ? right.blockId : "") ||
        ("actionId" in left ? left.actionId : "").localeCompare("actionId" in right ? right.actionId : ""),
    ),
    views: [...viewsById.values()].sort((left, right) => left.viewId.localeCompare(right.viewId)),
    insights: insights.sort((left, right) => left.pageId.localeCompare(right.pageId) || left.blockId.localeCompare(right.blockId)),
    recordQueries: recordQueries.sort(
      (left, right) => left.pageId.localeCompare(right.pageId) || left.blockId.localeCompare(right.blockId),
    ),
    records: pageRecords.sort((left, right) => left.pageId.localeCompare(right.pageId)),
    forms: forms.sort((left, right) =>
      ("pageId" in left ? `${left.pageId}\0${left.blockId}` : left.sidebarActionId).localeCompare(
        "pageId" in right ? `${right.pageId}\0${right.blockId}` : right.sidebarActionId,
      ),
    ),
    comments: comments.sort((left, right) => left.pageId.localeCompare(right.pageId) || left.blockId.localeCompare(right.blockId)),
    documents: documents.sort((left, right) => left.pageId.localeCompare(right.pageId) || left.blockId.localeCompare(right.blockId)),
    workflowLaunchers: workflowLaunchers.sort((left, right) =>
      `${left.pageId}\0${left.blockId}\0${left.actionId}`.localeCompare(`${right.pageId}\0${right.blockId}\0${right.actionId}`),
    ),
    scannerLaunchers: scannerLaunchers.sort(
      (left, right) => left.pageId.localeCompare(right.pageId) || left.blockId.localeCompare(right.blockId),
    ),
  });
  return {
    ok: true,
    compiled: { definition, capabilities, bindings: { appId: existingApp?.id ?? null, baseId: base.id } },
  };
};

export const get = async (id: string, client: SqlClient = sql): Promise<CustomApp | null> => {
  const [row] = await client<DbRow[]>`SELECT * FROM grids.custom_apps WHERE id = ${id}::uuid AND deleted_at IS NULL`;
  return row ? mapRow(row) : null;
};

export const getByShortIdForBase = async (baseId: string, shortId: string, client: SqlClient = sql): Promise<CustomApp | null> => {
  const [row] = await client<DbRow[]>`
    SELECT *
    FROM grids.custom_apps
    WHERE base_id = ${baseId}::uuid AND short_id = ${shortId} AND deleted_at IS NULL
  `;
  return row ? mapRow(row) : null;
};

export const getPublishedByShortId = async (shortId: string): Promise<CustomApp | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT app.*
    FROM grids.custom_apps app
    JOIN grids.bases base ON base.id = app.base_id AND base.deleted_at IS NULL
    WHERE app.short_id = ${shortId} AND app.published_definition IS NOT NULL AND app.deleted_at IS NULL
  `;
  if (!row) return null;
  const app = mapRow(row);
  return app.publishedValid ? app : null;
};

export const listByBase = async (baseId: string): Promise<CustomApp[]> => {
  const rows = await sql<DbRow[]>`SELECT * FROM grids.custom_apps WHERE base_id = ${baseId}::uuid AND deleted_at IS NULL ORDER BY name, id`;
  return rows.map(mapRow);
};

export const listSummariesByBase = async (baseId: string): Promise<CustomAppSummary[]> => {
  const rows = await sql<DbRow[]>`
    SELECT id, short_id, base_id, name, icon, draft_definition, draft_capabilities,
           published_definition, published_capabilities, published_at, updated_at
    FROM grids.custom_apps
    WHERE base_id = ${baseId}::uuid AND deleted_at IS NULL
    ORDER BY name, id
  `;
  return rows.map(mapSummaryRow);
};

const planCompilation = async (compilation: CustomAppCompilation, client: SqlClient = sql, locale?: string): Promise<CustomAppPlan> => {
  if (!compilation.ok) return { valid: false, diagnostics: compilation.diagnostics, action: "invalid", changes: [] };
  const { definition, capabilities, bindings } = compilation.compiled;
  const existing = bindings.appId ? await get(bindings.appId, client) : null;
  if (!existing) return { valid: true, diagnostics: [], action: "create", changes: ["app"] };
  const diagnostics: CustomAppDiagnostic[] = [];
  if (existing.shortId !== definition.id || existing.baseId !== bindings.baseId)
    diagnostics.push(customAppDiagnostic(locale, "identity.immutable", ["id"]));
  if (diagnostics.length > 0) return { valid: false, diagnostics, action: "invalid", changes: [] };
  const changes: string[] = [];
  if (stableCustomAppStringify(existing.draftDefinition) !== stableCustomAppStringify(definition)) changes.push("definition");
  if (stableCustomAppStringify(existing.draftCapabilities) !== stableCustomAppStringify(capabilities)) changes.push("capabilities");
  return { valid: true, diagnostics: [], action: changes.length === 0 ? "noop" : "update", changes };
};

export const plan = async (input: unknown, locale?: string): Promise<CustomAppPlan> =>
  planCompilation(await compile(input, sql, locale), sql, locale);

export type CustomAppDraftSave = {
  app: CustomApp;
  valid: boolean;
  diagnostics: CustomAppDiagnostic[];
};

export const saveDraft = async (id: string, input: unknown, locale?: string): Promise<Result<CustomAppDraftSave>> => {
  const t = customAppMessagesFor(locale);
  const parsed = CustomAppDefinitionSchema.safeParse(input);
  if (!parsed.success) return fail(err.badInput(t.invalidDefinition));
  return sql.begin(async (tx): Promise<Result<CustomAppDraftSave>> => {
    const [locked] = await tx<DbRow[]>`
      SELECT app.*, base.short_id AS base_short_id
      FROM grids.custom_apps app
      JOIN grids.bases base ON base.id = app.base_id
      WHERE app.id = ${id}::uuid AND app.deleted_at IS NULL
      FOR UPDATE OF app
    `;
    if (!locked) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    const existing = mapRow(locked);
    if (parsed.data.id !== existing.shortId || parsed.data.baseId !== locked.base_short_id) return fail(err.badInput(t.identityImmutable));
    const compilation = await compile(parsed.data, tx, locale);
    if (!compilation.ok) {
      const [updated] = await tx<DbRow[]>`
        UPDATE grids.custom_apps
        SET name = ${parsed.data.name}, icon = ${parsed.data.icon ?? null}, draft_definition = ${parsed.data}::jsonb,
            draft_capabilities = NULL, updated_at = now()
        WHERE id = ${id}::uuid AND deleted_at IS NULL
        RETURNING *
      `;
      if (!updated) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
      return ok({ app: mapRow(updated), valid: false, diagnostics: compilation.diagnostics });
    }
    const definition = parsed.data;
    const capabilities = compilation.compiled.capabilities;
    const diagnostics: CustomAppDiagnostic[] = [];
    const [updated] = await tx<DbRow[]>`
      UPDATE grids.custom_apps
      SET name = ${definition.name}, icon = ${definition.icon ?? null}, draft_definition = ${definition}::jsonb,
          draft_capabilities = ${capabilities}::jsonb, updated_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NULL
      RETURNING *
    `;
    if (!updated) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    const app = mapRow(updated);
    return ok({ app, valid: compilation.ok, diagnostics });
  });
};

export const restoreDraft = async (id: string, actorId: string | null = null, locale?: string): Promise<Result<CustomApp>> => {
  const t = customAppMessagesFor(locale);
  return sql.begin(async (tx): Promise<Result<CustomApp>> => {
    const [locked] = await tx<DbRow[]>`SELECT * FROM grids.custom_apps WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (!locked) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    if (!locked.published_definition || !locked.published_capabilities) return fail(err.badInput(t.noLiveVersion));
    const publishedRaw = parseJsonbRow(locked.published_definition, {});
    const published = parseStoredCustomAppDefinition(publishedRaw, "published");
    if (!published.definition) return fail(err.badInput(t.invalidLiveVersion));
    const publishedDefinition = published.definition;
    const [updated] = await tx<DbRow[]>`
      UPDATE grids.custom_apps
      SET name = ${publishedDefinition.name}, icon = ${publishedDefinition.icon ?? null},
          draft_definition = published_definition, draft_capabilities = published_capabilities, updated_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NULL
      RETURNING *
    `;
    if (!updated) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    const app = mapRow(updated);
    await logAudit(
      {
        baseId: app.baseId,
        userId: actorId,
        action: "updated",
        diff: { customAppDraftRestore: { old: locked.updated_at, new: app.updatedAt } },
      },
      tx,
    );
    return ok(app);
  });
};

export const createBlank = async (
  baseId: string,
  name: string,
  actorId: string | null = null,
  locale?: string,
): Promise<Result<CustomApp>> => {
  const t = customAppMessagesFor(locale);
  const [base] = await sql<Array<{ short_id: string }>>`
    SELECT short_id FROM grids.bases WHERE id = ${baseId}::uuid AND deleted_at IS NULL
  `;
  if (!base) return fail({ ...err.notFound("Base"), message: t.baseNotFound });
  const definition: CustomAppDefinition = {
    schemaVersion: 5,
    kind: "grids.custom-app",
    id: stdCrypto.common.readableId(6),
    baseId: base.short_id,
    name,
    startPageId: "home",
    pages: [
      {
        id: "home",
        title: t.home,
        navigation: { visible: true },
        parameters: {},
        rows: [
          {
            id: "row-1",
            columns: [{ id: "column-1", span: 12, blocks: [{ id: "welcome", type: "markdown", markdown: `# ${name}` }] }],
          },
        ],
      },
    ],
  };
  return apply(definition, actorId, locale);
};

export const apply = async (input: unknown, actorId: string | null = null, locale?: string): Promise<Result<CustomApp>> => {
  const t = customAppMessagesFor(locale);
  return sql.begin(async (tx): Promise<Result<CustomApp>> => {
    const compilation = await compile(input, tx, locale);
    const planned = await planCompilation(compilation, tx, locale);
    if (!planned.valid) {
      return fail(err.badInput(t.invalidDefinition));
    }
    if (!compilation.ok) return fail(err.badInput(t.invalidDefinition));
    const { definition: parsed, capabilities, bindings } = compilation.compiled;
    if (planned.action === "noop") return ok((await get(bindings.appId!, tx))!);
    if (planned.action === "create") {
      const [row] = await tx<DbRow[]>`
        INSERT INTO grids.custom_apps (id, short_id, base_id, name, icon, draft_definition, draft_capabilities)
        VALUES (${globalThis.crypto.randomUUID()}::uuid, ${parsed.id}, ${bindings.baseId}::uuid, ${parsed.name}, ${parsed.icon ?? null}, ${parsed}::jsonb, ${capabilities}::jsonb)
        RETURNING *
      `;
      if (!row) throw err.internal(t.createFailed);
      const app = mapRow(row);
      await logAudit(
        {
          baseId: app.baseId,
          userId: actorId,
          action: "created",
          diff: { customApp: { old: null, new: { id: app.id, name: app.name, shortId: app.shortId } } },
        },
        tx,
      );
      return ok(app);
    }
    const existing = bindings.appId ? await get(bindings.appId, tx) : null;
    if (!existing) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    const definition = parsed;
    const [updated] = await tx<DbRow[]>`
      UPDATE grids.custom_apps
      SET name = ${definition.name}, icon = ${definition.icon ?? null}, draft_definition = ${definition}::jsonb,
          draft_capabilities = ${capabilities}::jsonb, updated_at = now()
      WHERE id = ${bindings.appId}::uuid AND deleted_at IS NULL
      RETURNING *
    `;
    if (!updated) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    const app = mapRow(updated);
    await logAudit(
      {
        baseId: app.baseId,
        userId: actorId,
        action: "updated",
        diff: { customApp: { old: existing.name, new: app.name } },
      },
      tx,
    );
    return ok(app);
  });
};

export const publish = async (id: string, actorId: string | null = null, locale?: string): Promise<Result<CustomApp>> => {
  const t = customAppMessagesFor(locale);
  return sql.begin(async (tx): Promise<Result<CustomApp>> => {
    const [locked] = await tx<DbRow[]>`SELECT * FROM grids.custom_apps WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (!locked) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    const draft = mapRow(locked);
    if (!draft.draftDefinition) return fail(err.badInput(t.invalidDraft));
    const compilation = await compile(draft.draftDefinition, tx, locale);
    if (!compilation.ok) return fail(err.badInput(t.invalidDraft));
    const [published] = await tx<DbRow[]>`
      UPDATE grids.custom_apps
      SET published_definition = draft_definition, published_capabilities = ${compilation.compiled.capabilities}::jsonb,
          published_at = now(), updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING *
    `;
    if (!published) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    const app = mapRow(published);
    await logAudit(
      {
        baseId: app.baseId,
        userId: actorId,
        action: "updated",
        diff: { customAppPublication: { old: locked.published_at ?? null, new: app.publishedAt } },
      },
      tx,
    );
    return ok(app);
  });
};

export const unpublish = async (id: string, actorId: string | null = null, locale?: string): Promise<Result<CustomApp>> => {
  const t = customAppMessagesFor(locale);
  return sql.begin(async (tx): Promise<Result<CustomApp>> => {
    const [locked] = await tx<DbRow[]>`SELECT * FROM grids.custom_apps WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
    if (!locked) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    if (!locked.published_definition) return ok(mapRow(locked));
    const [unpublished] = await tx<DbRow[]>`
      UPDATE grids.custom_apps
      SET published_definition = NULL, published_capabilities = NULL, published_at = NULL, updated_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NULL
      RETURNING *
    `;
    if (!unpublished) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    const app = mapRow(unpublished);
    await logAudit(
      {
        baseId: app.baseId,
        userId: actorId,
        action: "updated",
        diff: { customAppPublication: { old: locked.published_at ?? null, new: null } },
      },
      tx,
    );
    return ok(app);
  });
};

export const remove = async (id: string, actorId: string | null = null, locale?: string): Promise<Result<void>> => {
  const t = customAppMessagesFor(locale);
  return sql.begin(async (tx): Promise<Result<void>> => {
    const [deleted] = await tx<Array<{ base_id: string; name: string; short_id: string }>>`
      UPDATE grids.custom_apps
      SET deleted_at = now(), published_definition = NULL, published_capabilities = NULL, published_at = NULL, updated_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NULL
      RETURNING base_id, name, short_id
    `;
    if (!deleted) return fail({ ...err.notFound("Grids App"), message: t.customAppNotFound });
    await logAudit(
      {
        baseId: deleted.base_id,
        userId: actorId,
        action: "deleted",
        diff: { customApp: { old: { id, name: deleted.name, shortId: deleted.short_id }, new: null } },
      },
      tx,
    );
    return ok(undefined);
  });
};
