import { err, fail, ok, type Result } from "@k2b/stdlib";
import { logger } from "@valentinkolb/cloud/services";
import { parseDataUrl } from "@valentinkolb/cloud/shared";
import { deleteWorkflowScope } from "@valentinkolb/cloud/workflows/store";
import { sql } from "bun";
import { documentTemplateStarterById } from "../document-template-starters";
import { type GridTemplate, getTemplate, getTemplates, type TemplateDateExpression, type TemplateRef } from "../templates";
import type { GridsWorkflow } from "../workflows/contracts";
import * as bases from "./bases";
import * as customApps from "./custom-apps";
import * as documents from "./documents";
import * as emailTemplates from "./email-templates";
import * as fields from "./fields";
import * as files from "./files";
import type { FormConfig } from "./forms";
import * as forms from "./forms";
import { serviceMessagesFor } from "./messages";
import * as records from "./records";
import { newShortId } from "./short-id";
import * as tables from "./tables";
import type { Base, Field } from "./types";
import * as views from "./views";
import { createWorkflow } from "./workflow-definitions";
import { createLauncher } from "./workflow-launchers";
import { GRIDS_APP_ID } from "./workflow-runs";

const log = logger("grids:templates");

type TemplateSummary = {
  id: string;
  name: string;
  description: string;
  highlights: [string, string, string];
  icon: string;
};

type InstantiateTemplateInput = {
  name?: string;
  withSampleData?: boolean;
};

type TemplateContext = {
  tables: Map<string, string>;
  tableNames: Map<string, string>;
  fields: Map<string, Field>;
  records: Map<string, string>;
  views: Map<string, string>;
  viewNames: Map<string, string>;
  viewColumns: Map<string, string[]>;
  forms: Map<string, string>;
  workflows: Map<string, GridsWorkflow>;
  launchers: Map<string, string>;
  documentTemplates: Map<string, string>;
  publicRefs: Map<string, string>;
  publicViewColumns: Map<string, string[]>;
};

type ResultError = Extract<Result<unknown>, { ok: false }>["error"];

class TemplateError extends Error {
  constructor(public readonly resultError: ResultError) {
    super(resultError.message);
  }
}

const summarizeTemplate = (template: GridTemplate): TemplateSummary => ({
  id: template.id,
  name: template.name,
  description: template.description,
  highlights: template.highlights,
  icon: template.icon,
});

export const list = (locale?: string): TemplateSummary[] => getTemplates(locale).map(summarizeTemplate);

export const get = (id: string, locale?: string): TemplateSummary | null => {
  const template = getTemplate(id, locale);
  return template ? summarizeTemplate(template) : null;
};

const requireResult = <T>(result: Result<T>): T => {
  if (!result.ok) throw new TemplateError(result.error);
  return result.data;
};

const isRef = (value: unknown): value is TemplateRef =>
  !!value &&
  typeof value === "object" &&
  (value as Record<string, unknown>).$ref !== undefined &&
  typeof (value as Record<string, unknown>).key === "string";

const isFormulaExpression = (value: unknown): value is { $formula: Array<string | TemplateRef> } =>
  !!value && typeof value === "object" && Array.isArray((value as { $formula?: unknown }).$formula);

const isDateExpression = (value: unknown): value is TemplateDateExpression =>
  !!value && typeof value === "object" && (value as { $date?: unknown }).$date === "current_month";

const formatTemplateDate = (expression: TemplateDateExpression, now = new Date()): string => {
  const monthOffset = Number.isInteger(expression.monthOffset) ? (expression.monthOffset ?? 0) : 0;
  const base = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const day = Math.min(Math.max(1, Math.trunc(expression.day)), lastDay);
  const yyyy = String(base.getFullYear()).padStart(4, "0");
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const resolveRef = (ref: TemplateRef, ctx: TemplateContext): string => {
  const value = {
    table: () => ctx.tables.get(ref.key),
    field: () => ctx.fields.get(ref.key)?.id,
    record: () => ctx.records.get(ref.key),
    view: () => ctx.views.get(ref.key),
    form: () => ctx.forms.get(ref.key),
    launcher: () => ctx.launchers.get(ref.key),
    documentTemplate: () => ctx.documentTemplates.get(ref.key),
  }[ref.$ref]();

  if (!value) throw new TemplateError(err.badInput(`template reference not found: ${ref.$ref}:${ref.key}`));
  return value;
};

const resolvePublicRef = (ref: TemplateRef, ctx: TemplateContext): string => {
  const value = ctx.publicRefs.get(`${ref.$ref}:${ref.key}`);
  if (!value) throw new TemplateError(err.badInput(`template public reference not found: ${ref.$ref}:${ref.key}`));
  return value;
};

const isViewColumnsRef = (value: unknown): value is { $ref: "viewColumns"; key: string } =>
  !!value &&
  typeof value === "object" &&
  (value as Record<string, unknown>).$ref === "viewColumns" &&
  typeof (value as Record<string, unknown>).key === "string";

const resolveValue = (value: unknown, ctx: TemplateContext): unknown => {
  if (value === undefined) return undefined;
  if (isRef(value)) return resolveRef(value, ctx);
  if (isFormulaExpression(value)) {
    return value.$formula.map((part) => (typeof part === "string" ? part : `{${resolvePublicRef(part, ctx)}}`)).join("");
  }
  if (isDateExpression(value)) return formatTemplateDate(value);
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveValue(nested, ctx)]));
  }
  return value;
};

const GQL_RESERVED_REFS = new Set([
  "aggregate",
  "and",
  "as",
  "by",
  "deleted",
  "false",
  "first",
  "from",
  "group",
  "having",
  "include",
  "join",
  "last",
  "left",
  "limit",
  "not",
  "null",
  "nulls",
  "offset",
  "on",
  "only",
  "or",
  "search",
  "select",
  "sort",
  "table",
  "true",
  "view",
  "where",
]);

const gqlRef = (name: string): string => {
  const trimmed = name.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) && !GQL_RESERVED_REFS.has(trimmed.toLowerCase())) return trimmed;
  return `"${trimmed.replaceAll('"', '""')}"`;
};

const resolveGqlRef = (ref: TemplateRef, ctx: TemplateContext): string => {
  const value =
    ref.$ref === "table"
      ? ctx.tableNames.get(ref.key)
      : ref.$ref === "field"
        ? ctx.fields.get(ref.key)?.name
        : ref.$ref === "view"
          ? ctx.viewNames.get(ref.key)
          : null;

  if (!value) throw new TemplateError(err.badInput(`template GQL reference not found: ${ref.$ref}:${ref.key}`));
  return gqlRef(value);
};

const resolveGqlValue = (value: unknown, ctx: TemplateContext): unknown => {
  if (value === undefined) return undefined;
  if (isRef(value)) return resolveGqlRef(value, ctx);
  if (isFormulaExpression(value)) {
    return value.$formula.map((part) => (typeof part === "string" ? part : resolveGqlRef(part, ctx))).join("");
  }
  if (Array.isArray(value)) return value.map((item) => resolveGqlValue(item, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveGqlValue(nested, ctx)]));
  }
  return value;
};

const resolveCustomAppValue = (value: unknown, ctx: TemplateContext): unknown => {
  if (value === undefined) return undefined;
  if (isViewColumnsRef(value)) {
    const columns = ctx.publicViewColumns.get(value.key);
    if (!columns) throw new TemplateError(err.badInput(`template view columns not found: ${value.key}`));
    return columns;
  }
  if (isRef(value)) return resolvePublicRef(value, ctx);
  if (isFormulaExpression(value)) {
    return value.$formula.map((part) => (typeof part === "string" ? part : `{${resolvePublicRef(part, ctx)}}`)).join("");
  }
  if (isDateExpression(value)) return formatTemplateDate(value);
  if (Array.isArray(value)) return value.map((item) => resolveCustomAppValue(item, ctx));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [
      key,
      record.kind === "gql" && key === "query" ? resolveGqlValue(nested, ctx) : resolveCustomAppValue(nested, ctx),
    ]),
  );
};

const createTables = async (template: GridTemplate, baseId: string, actorId: string | null, ctx: TemplateContext) => {
  for (const table of template.tables) {
    const created = requireResult(
      await tables.create(
        {
          baseId,
          name: table.name,
          description: table.description ?? null,
        },
        actorId,
      ),
    );
    ctx.tables.set(table.key, created.id);
    ctx.publicRefs.set(`table:${table.key}`, created.shortId);
    ctx.tableNames.set(table.key, created.name);
  }
};

const createFields = async (template: GridTemplate, actorId: string | null, ctx: TemplateContext) => {
  for (const table of template.tables) {
    const tableId = ctx.tables.get(table.key);
    if (!tableId) throw new TemplateError(err.badInput(`template table not found: ${table.key}`));

    for (const field of table.fields) {
      const created = requireResult(
        await fields.create(
          {
            tableId,
            name: field.name,
            type: field.type,
            description: field.description ?? null,
            icon: field.icon ?? null,
            config: (resolveValue(field.config, ctx) as Record<string, unknown> | undefined) ?? {},
            required: field.required,
            presentable: field.presentable,
            hideInTable: field.hideInTable,
            defaultValue: resolveValue(field.defaultValue, ctx),
            indexed: field.indexed,
            uniqueConstraint: field.uniqueConstraint,
          },
          actorId,
        ),
      );
      ctx.fields.set(`${table.key}.${field.key}`, created);
      ctx.publicRefs.set(`field:${table.key}.${field.key}`, created.shortId);
    }
  }
};

const applyTableDisplayConfigs = async (template: GridTemplate, actorId: string | null, ctx: TemplateContext) => {
  for (const table of template.tables) {
    if (!table.displayConfig) continue;
    const tableId = ctx.tables.get(table.key);
    if (!tableId) throw new TemplateError(err.badInput(`template table not found: ${table.key}`));
    requireResult(
      await tables.update(
        tableId,
        {
          displayConfig: resolveValue(table.displayConfig, ctx) as Parameters<typeof tables.update>[1]["displayConfig"],
        },
        actorId,
      ),
    );
  }
};

const createRecords = async (template: GridTemplate, actorId: string | null, ctx: TemplateContext) => {
  for (const record of template.records ?? []) {
    const tableId = ctx.tables.get(record.table);
    if (!tableId) throw new TemplateError(err.badInput(`template table not found: ${record.table}`));

    const data: Record<string, unknown> = {};
    for (const [fieldKey, value] of Object.entries(record.values)) {
      const field = ctx.fields.get(`${record.table}.${fieldKey}`);
      if (!field) {
        throw new TemplateError(err.badInput(`template field not found: ${record.table}.${fieldKey}`));
      }
      data[field.id] = resolveValue(value, ctx);
    }

    const created = requireResult(await records.create(tableId, data, actorId, "direct"));
    ctx.records.set(record.key, created.id);
    ctx.publicRefs.set(`record:${record.key}`, created.shortId);

    for (const attachment of record.files ?? []) {
      const field = ctx.fields.get(`${record.table}.${attachment.field}`);
      if (!field) {
        throw new TemplateError(err.badInput(`template file field not found: ${record.table}.${attachment.field}`));
      }
      const parsed = parseDataUrl(attachment.dataUrl);
      if (!parsed) {
        throw new TemplateError(err.badInput(`template file is not a base64 data URL: ${record.table}.${attachment.field}`));
      }
      requireResult(
        await files.upload({
          tableId,
          recordId: created.id,
          fieldId: field.id,
          filename: attachment.filename,
          mimeType: parsed.mimeType,
          bytes: parsed.bytes,
          userId: actorId,
          origin: "direct",
        }),
      );
    }
  }
};

const createViews = async (template: GridTemplate, actorId: string | null, ctx: TemplateContext) => {
  for (const view of template.views ?? []) {
    const tableId = ctx.tables.get(view.table);
    if (!tableId) throw new TemplateError(err.badInput(`template table not found: ${view.table}`));
    const source =
      view.source === undefined
        ? `from table ${resolveGqlRef({ $ref: "table", key: view.table }, ctx)}`
        : resolveGqlValue(view.source, ctx);
    if (typeof source !== "string" || !source.trim()) {
      throw new TemplateError(err.badInput(`template view "${view.name}" must provide a GQL source`));
    }

    const created = requireResult(
      await views.create(
        {
          tableId,
          name: view.name,
          source: source.trim(),
          ui: resolveValue(view.ui ?? {}, ctx) as Parameters<typeof views.create>[0]["ui"],
          ownerUserId: view.shared === false ? actorId : null,
        },
        actorId,
      ),
    );
    ctx.views.set(view.key, created.id);
    ctx.publicRefs.set(`view:${view.key}`, created.shortId);
    ctx.viewNames.set(view.key, created.name);
    ctx.viewColumns.set(
      view.key,
      created.ui.columns?.flatMap((column) => ("fieldId" in column ? [column.fieldId] : [])) ??
        [...ctx.fields.entries()].filter(([key]) => key.startsWith(`${view.table}.`)).map(([, field]) => field.id),
    );
    ctx.publicViewColumns.set(
      view.key,
      created.ui.columns?.flatMap((column) => {
        if (!("fieldId" in column)) return [];
        const field = [...ctx.fields.values()].find((candidate) => candidate.id === column.fieldId);
        return field ? [field.shortId] : [];
      }) ?? [...ctx.fields.entries()].filter(([key]) => key.startsWith(`${view.table}.`)).map(([, field]) => field.shortId),
    );
  }
};

const createForms = async (template: GridTemplate, actorId: string | null, ctx: TemplateContext, locale?: string) => {
  for (const form of template.forms ?? []) {
    const tableId = ctx.tables.get(form.table);
    if (!tableId) throw new TemplateError(err.badInput(`template table not found: ${form.table}`));

    const created = requireResult(
      await forms.create(
        {
          tableId,
          name: form.name,
          isPublic: form.isPublic,
          config: resolveValue(form.config, ctx) as FormConfig,
        },
        actorId,
        locale,
      ),
    );
    ctx.forms.set(form.key, created.id);
    ctx.publicRefs.set(`form:${form.key}`, created.shortId);
  }
};

const createCustomApps = async (template: GridTemplate, base: Base, actorId: string | null, ctx: TemplateContext, locale?: string) => {
  for (const templateApp of template.customApps ?? []) {
    const appId = newShortId();
    const resolved = resolveCustomAppValue(templateApp.definition, ctx);
    const created = requireResult(
      await customApps.apply(
        {
          ...(resolved as Record<string, unknown>),
          id: appId,
          baseId: base.shortId,
        },
        actorId,
        locale,
      ),
    );
    requireResult(await customApps.publish(created.id, actorId, locale));
  }
};

const createDocumentTemplates = async (template: GridTemplate, actorId: string | null, ctx: TemplateContext, locale?: string) => {
  for (const definition of template.documentTemplates ?? []) {
    const tableId = ctx.tables.get(definition.table);
    if (!tableId) throw new TemplateError(err.badInput(`template table not found: ${definition.table}`));
    const starter = documentTemplateStarterById(definition.starterId, locale);
    if (!starter) throw new TemplateError(err.badInput(`document template starter not found: ${definition.starterId}`));
    const source = definition.source === undefined ? starter.source(tableId) : resolveGqlValue(definition.source, ctx);
    if (typeof source !== "string" || !source.trim()) {
      throw new TemplateError(err.badInput(`document template "${definition.key}" must provide a GQL source`));
    }

    const created = requireResult(
      await documents.createTemplate(
        tableId,
        {
          name: definition.name?.trim() || starter.name,
          description: definition.description === undefined ? starter.description : definition.description,
          source: source.trim(),
          renderer: starter.renderer,
          enabled: definition.enabled,
        },
        actorId,
        locale,
      ),
    );
    ctx.documentTemplates.set(definition.key, created.id);
    ctx.publicRefs.set(`documentTemplate:${definition.key}`, created.shortId);
  }
};

const createEmailTemplates = async (template: GridTemplate, baseId: string, actorId: string | null, locale?: string) => {
  for (const definition of template.emailTemplates ?? []) {
    requireResult(
      await emailTemplates.create(
        baseId,
        {
          name: definition.name,
          description: definition.description,
          subject: definition.subject,
          html: definition.html,
          sampleData: definition.sampleData,
          enabled: definition.enabled,
        },
        actorId,
        locale,
      ),
    );
  }
};

const createWorkflows = async (template: GridTemplate, baseId: string, actorId: string | null, ctx: TemplateContext, locale?: string) => {
  for (const definition of template.workflows ?? []) {
    const created = requireResult(
      await createWorkflow(
        baseId,
        {
          name: definition.name,
          description: definition.description,
          source: definition.source,
          enabled: definition.enabled,
        },
        actorId,
        locale,
      ),
    );
    ctx.workflows.set(definition.key, created);
  }
};

const createWorkflowLaunchers = async (template: GridTemplate, actorId: string | null, ctx: TemplateContext, locale?: string) => {
  for (const definition of template.workflowLaunchers ?? []) {
    const workflow = ctx.workflows.get(definition.workflow);
    if (!workflow) throw new TemplateError(err.badInput(`template workflow not found: ${definition.workflow}`));
    const created = requireResult(
      await createLauncher(
        workflow,
        {
          name: definition.name,
          config: definition.config,
          enabled: definition.enabled,
        },
        actorId,
        locale,
      ),
    );
    ctx.launchers.set(definition.key, created.id);
    ctx.publicRefs.set(`launcher:${definition.key}`, created.shortId);
  }
};

export const instantiate = async (
  templateId: string,
  input: InstantiateTemplateInput,
  actorId: string | null,
  locale?: string,
): Promise<Result<Base>> => {
  const t = serviceMessagesFor(locale);
  const template = getTemplate(templateId, locale);
  if (!template) return fail({ ...err.notFound("Template"), message: t.templateNotFound });

  const name = input.name?.trim() || template.baseName;
  const baseResult = await bases.create(
    {
      name,
      description: template.baseDescription ?? template.description,
    },
    actorId,
  );
  if (!baseResult.ok) return baseResult;
  const base = baseResult.data;

  const ctx: TemplateContext = {
    tables: new Map(),
    tableNames: new Map(),
    fields: new Map(),
    records: new Map(),
    views: new Map(),
    viewNames: new Map(),
    viewColumns: new Map(),
    forms: new Map(),
    workflows: new Map(),
    launchers: new Map(),
    documentTemplates: new Map(),
    publicRefs: new Map(),
    publicViewColumns: new Map(),
  };

  try {
    await createTables(template, base.id, actorId, ctx);
    await createFields(template, actorId, ctx);
    await applyTableDisplayConfigs(template, actorId, ctx);
    if (input.withSampleData !== false) await createRecords(template, actorId, ctx);
    await createViews(template, actorId, ctx);
    await createForms(template, actorId, ctx, locale);
    await createDocumentTemplates(template, actorId, ctx, locale);
    await createEmailTemplates(template, base.id, actorId, locale);
    await createWorkflows(template, base.id, actorId, ctx, locale);
    await createWorkflowLaunchers(template, actorId, ctx, locale);
    await createCustomApps(template, base, actorId, ctx, locale);
    return ok(base);
  } catch (error) {
    // Nothing in the kernel references a Grids table, so dropping the base does
    // not cascade into it. Without this every failed instantiation leaves the
    // template's workflows, versions and activations behind for good — with an
    // enabled `grids.invoked` activation pointing at a base that is gone.
    await deleteWorkflowScope({ appId: GRIDS_APP_ID, scopeId: base.id }).catch(() => {});
    await sql`DELETE FROM grids.bases WHERE id = ${base.id}::uuid`.catch(() => {});
    log.error("Template instantiation failed", {
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail({ ...err.internal("Could not create base from template."), message: t.templateCreateFailed });
  }
};
