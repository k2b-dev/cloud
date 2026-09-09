import { describe, expect, test } from "bun:test";
import { parseDataUrl } from "@k2b/cloud/shared";
import { compileWorkflow } from "@k2b/cloud/workflows/language";
import {
  CreateBaseSchema,
  CreateDocumentTemplateSchema,
  CreateEmailTemplateSchema,
  CreateFieldSchema,
  CreateTableSchema,
  CreateViewSchema,
  FormConfigSchema,
  RecordDisplayConfigSchema,
  ViewUiSettingsSchema,
} from "../contracts";
import { CustomAppDefinitionSchema } from "../custom-apps/contracts";
import { documentTemplateStarterById } from "../document-template-starters";
import { fieldTypeRegistry, getRecordWritableFieldType } from "../field-types";
import { bindDslQueryContext } from "../query-dsl/parameters";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { type DslResolverContext, resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { renderDocumentHtml, renderDocumentSource, validateTemplateWrite } from "../service/documents";
import { renderEmailTemplate, validateEmailTemplateWrite } from "../service/email-templates";
import type { Field } from "../service/types";
import { buildWorkflowCatalog } from "../service/workflow-catalog";
import { validateLauncherConfig } from "../service/workflow-launchers";
import { bindGridsWorkflow } from "../workflows/binder";
import { CreateGridsWorkflowSchema, scannerLauncherInputSources } from "../workflows/contracts";
import { gridsWorkflows } from "../workflows/module";
import { getTemplates, templates } from ".";
import type { GridTemplate, TemplateDateExpression, TemplateField, TemplateRef } from "./types";
import { field, formula } from "./types";

const isRef = (value: unknown): value is TemplateRef =>
  !!value &&
  typeof value === "object" &&
  ["table", "field", "record", "view", "form", "launcher", "documentTemplate"].includes(String((value as Record<string, unknown>).$ref)) &&
  typeof (value as Record<string, unknown>).key === "string";

const isViewColumnsRef = (value: unknown): value is { $ref: "viewColumns"; key: string } =>
  !!value &&
  typeof value === "object" &&
  (value as Record<string, unknown>).$ref === "viewColumns" &&
  typeof (value as Record<string, unknown>).key === "string";

const isCurrentMonthDate = (value: unknown): value is TemplateDateExpression =>
  !!value && typeof value === "object" && (value as { $date?: unknown }).$date === "current_month";

const isFormulaExpression = (value: unknown): value is { $formula: Array<string | TemplateRef> } =>
  !!value && typeof value === "object" && Array.isArray((value as { $formula?: unknown }).$formula);

const refsIn = (value: unknown): TemplateRef[] => {
  if (isRef(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(refsIn);
  return [];
};

type TemplateTestContext = {
  tables: Map<string, string>;
  fields: Map<string, string>;
  records: Map<string, string>;
  views: Map<string, string>;
  viewColumns: Map<string, string[]>;
  forms: Map<string, string>;
  launchers: Map<string, string>;
  documentTemplates: Map<string, string>;
};

const testUuid = (index: number): string => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const templateTestContext = (template: GridTemplate): TemplateTestContext => {
  let index = 1;
  const tables = new Map<string, string>();
  const fields = new Map<string, string>();
  const records = new Map<string, string>();
  const views = new Map<string, string>();
  const viewColumns = new Map<string, string[]>();
  const forms = new Map<string, string>();
  const launchers = new Map<string, string>();
  const documentTemplates = new Map<string, string>();

  for (const table of template.tables) {
    tables.set(table.key, testUuid(index++));
    for (const field of table.fields) fields.set(`${table.key}.${field.key}`, testUuid(index++));
  }
  for (const record of template.records ?? []) records.set(record.key, testUuid(index++));
  for (const view of template.views ?? []) {
    views.set(view.key, testUuid(index++));
    viewColumns.set(
      view.key,
      template.tables.find((table) => table.key === view.table)?.fields.map((field) => fields.get(`${view.table}.${field.key}`)!) ?? [],
    );
  }
  for (const form of template.forms ?? []) forms.set(form.key, testUuid(index++));
  for (const launcher of template.workflowLaunchers ?? []) launchers.set(launcher.key, testUuid(index++));

  for (const document of template.documentTemplates ?? []) documentTemplates.set(document.key, testUuid(index++));
  return { tables, fields, records, views, viewColumns, forms, launchers, documentTemplates };
};

const resolveTestRef = (ref: TemplateRef, ctx: TemplateTestContext): string => {
  const value = {
    table: () => ctx.tables.get(ref.key),
    field: () => ctx.fields.get(ref.key),
    record: () => ctx.records.get(ref.key),
    view: () => ctx.views.get(ref.key),
    form: () => ctx.forms.get(ref.key),
    launcher: () => ctx.launchers.get(ref.key),
    documentTemplate: () => ctx.documentTemplates.get(ref.key),
  }[ref.$ref]();
  if (!value) throw new Error(`missing template test ref ${ref.$ref}:${ref.key}`);
  return value;
};

const publicTestRef = (ref: TemplateRef): string => {
  let hash = 0;
  for (const character of `${ref.$ref}:${ref.key}`) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash.toString(36).toUpperCase().padStart(6, "0").slice(-6);
};

const resolveTestValue = (value: unknown, ctx: TemplateTestContext): unknown => {
  if (value === undefined) return undefined;
  if (isViewColumnsRef(value)) {
    const columns = ctx.viewColumns.get(value.key);
    if (!columns) throw new Error(`missing template test view columns ${value.key}`);
    return columns;
  }
  if (isRef(value)) return resolveTestRef(value, ctx);
  if (isFormulaExpression(value)) {
    return value.$formula.map((part) => (typeof part === "string" ? part : `{${publicTestRef(part)}}`)).join("");
  }
  if (isCurrentMonthDate(value)) return "2026-06-15";
  if (Array.isArray(value)) return value.map((item) => resolveTestValue(item, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveTestValue(nested, ctx)]));
  }
  return value;
};

const resolveTestCustomAppValue = (value: unknown, ctx: TemplateTestContext): unknown => {
  if (value === undefined) return undefined;
  if (isViewColumnsRef(value)) {
    const columns = ctx.viewColumns.get(value.key);
    if (!columns) throw new Error(`missing template test view columns ${value.key}`);
    return columns.map((_column, index) => publicTestRef({ $ref: "field", key: `${value.key}:${index}` }));
  }
  if (isRef(value)) return publicTestRef(value);
  if (isFormulaExpression(value)) {
    return value.$formula.map((part) => (typeof part === "string" ? part : `{${publicTestRef(part)}}`)).join("");
  }
  if (isCurrentMonthDate(value)) return "2026-06-15";
  if (Array.isArray(value)) return value.map((item) => resolveTestCustomAppValue(item, ctx));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveTestCustomAppValue(nested, ctx)]));
  }
  return value;
};

const indexTemplate = (template: GridTemplate) => {
  const tables = new Set(template.tables.map((table) => table.key));
  const fields = new Set(template.tables.flatMap((table) => table.fields.map((field) => `${table.key}.${field.key}`)));
  const records = new Set((template.records ?? []).map((record) => record.key));
  const views = new Set((template.views ?? []).map((view) => view.key));
  const forms = new Set((template.forms ?? []).map((form) => form.key));
  const launchers = new Set((template.workflowLaunchers ?? []).map((launcher) => launcher.key));
  const documentTemplates = new Set((template.documentTemplates ?? []).map((document) => document.key));
  return { tables, fields, records, views, forms, launchers, documentTemplates };
};

const assertUnique = (values: string[], label: string) => {
  expect(new Set(values).size, `${label} must be unique`).toBe(values.length);
};

const customAppBlocks = (template: GridTemplate): Array<Record<string, unknown>> =>
  (template.customApps ?? []).flatMap((app) =>
    app.definition.pages.flatMap((page) =>
      page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks as Array<Record<string, unknown>>)),
    ),
  );

const labelsIn = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(labelsIn);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    ...(key === "label" && typeof nested === "string" ? [nested] : []),
    ...labelsIn(nested),
  ]);
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

const templateNamesForGql = (template: GridTemplate) => {
  const tables = new Map<string, string>();
  const fields = new Map<string, string>();
  for (const table of template.tables) {
    tables.set(table.key, table.name);
    for (const field of table.fields) fields.set(`${table.key}.${field.key}`, field.name);
  }
  return { tables, fields };
};

const resolveTemplateGqlValue = (value: unknown, names: ReturnType<typeof templateNamesForGql>): unknown => {
  if (isRef(value)) {
    const resolved =
      value.$ref === "table" ? names.tables.get(value.key) : value.$ref === "field" ? names.fields.get(value.key) : undefined;
    if (!resolved) throw new Error(`unsupported GQL template ref ${value.$ref}:${value.key}`);
    return gqlRef(resolved);
  }
  if (isFormulaExpression(value)) {
    return value.$formula.map((part) => (typeof part === "string" ? part : resolveTemplateGqlValue(part, names))).join("");
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplateGqlValue(item, names));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveTemplateGqlValue(nested, names)]));
  }
  return value;
};

const templateFieldForResolver = (
  templateField: TemplateField,
  tableId: string,
  fieldId: string,
  position: number,
  ctx: TemplateTestContext,
): Field => ({
  id: fieldId,
  shortId: templateField.key,
  tableId,
  name: templateField.name,
  description: templateField.description ?? null,
  icon: templateField.icon ?? null,
  type: templateField.type,
  config: (resolveTestValue(templateField.config ?? {}, ctx) ?? {}) as Record<string, unknown>,
  position,
  required: templateField.required === true,
  presentable: templateField.presentable === true,
  hideInTable: templateField.hideInTable === true,
  defaultValue: resolveTestValue(templateField.defaultValue ?? null, ctx),
  indexed: templateField.indexed === true,
  uniqueConstraint: templateField.uniqueConstraint === true,
  deletedAt: null,
  createdAt: "2026-06-15T00:00:00.000Z",
  updatedAt: "2026-06-15T00:00:00.000Z",
});

const templateResolverContext = (template: GridTemplate, currentTableKey: string, ctx: TemplateTestContext): DslResolverContext => {
  const tables = template.tables.map((table) => ({
    kind: "table" as const,
    id: resolveTestRef({ $ref: "table", key: table.key }, ctx),
    shortId: table.key,
    name: table.name,
  }));
  const fieldsByTableId = Object.fromEntries(
    template.tables.map((table) => {
      const tableId = resolveTestRef({ $ref: "table", key: table.key }, ctx);
      return [
        tableId,
        table.fields.map((templateField, index) =>
          templateFieldForResolver(
            templateField,
            tableId,
            resolveTestRef({ $ref: "field", key: `${table.key}.${templateField.key}` }, ctx),
            index,
            ctx,
          ),
        ),
      ];
    }),
  ) as Record<string, Field[]>;
  const currentTableId = resolveTestRef({ $ref: "table", key: currentTableKey }, ctx);
  const currentTable = tables.find((table) => table.id === currentTableId);
  if (!currentTable) throw new Error(`missing current template table ${currentTableKey}`);
  return { currentTable, tables, fieldsByTableId, views: [] };
};

describe("built-in grid templates", () => {
  test("localizes templates with BCP-47 fallback while preserving stable structure", () => {
    const english = getTemplates("en");
    const german = getTemplates("de");

    expect(english).toEqual(templates);
    expect(getTemplates("fr")).toEqual(english);
    expect(getTemplates("de-CH")).toEqual(german);
    expect(german.map((template) => template.name)).toEqual(["Buchhandlung", "Private Finanzen", "Inventar"]);

    const stableShape = (template: GridTemplate) => ({
      id: template.id,
      icon: template.icon,
      tables: template.tables.map((table) => ({
        key: table.key,
        fields: table.fields.map((field) => ({
          key: field.key,
          type: field.type,
          icon: field.icon,
          optionIds: ((field.config as { options?: Array<{ id: string }> } | undefined)?.options ?? []).map((option) => option.id),
        })),
      })),
      records: (template.records ?? []).map((record) => ({ key: record.key, table: record.table })),
      views: (template.views ?? []).map((view) => ({ key: view.key, table: view.table })),
      forms: (template.forms ?? []).map((form) => ({ key: form.key, table: form.table })),
      customApps: (template.customApps ?? []).map((app) => app.key),
      documentTemplates: (template.documentTemplates ?? []).map((document) => ({
        key: document.key,
        table: document.table,
        starterId: document.starterId,
      })),
      emailTemplates: (template.emailTemplates ?? []).map((email) => email.key),
      workflows: (template.workflows ?? []).map((workflow) => workflow.key),
      launchers: (template.workflowLaunchers ?? []).map((launcher) => ({
        key: launcher.key,
        workflow: launcher.workflow,
        kind: launcher.config.kind,
      })),
    });

    for (const [index, template] of english.entries()) expect(stableShape(german[index]!)).toEqual(stableShape(template));
  });

  test("template ids are unique", () => {
    assertUnique(
      templates.map((template) => template.id),
      "template ids",
    );
  });

  test("every localized template connects documents and workflows to record detail pages", () => {
    for (const locale of ["en", "de"]) {
      for (const template of getTemplates(locale)) {
        expect(template.workflows?.length, template.id).toBeGreaterThan(0);
        expect(template.workflows?.every((workflow) => workflow.enabled !== false)).toBe(true);
        expect(template.documentTemplates?.length, template.id).toBeGreaterThan(0);
        expect(template.customApps?.length, template.id).toBeGreaterThan(0);
        const apps = (template.customApps ?? []).map((app) => {
          const resolved = resolveTestCustomAppValue(app.definition, templateTestContext(template));
          if (!resolved || typeof resolved !== "object") throw new Error("Expected App definition");
          return CustomAppDefinitionSchema.parse({ ...resolved, id: "APP001", baseId: "BASE01" });
        });
        const documentIds = apps.flatMap((app) =>
          app.pages.flatMap((page) =>
            page.rows.flatMap((row) =>
              row.columns.flatMap((column) =>
                column.blocks.flatMap((block) => (block.type === "record" ? (block.documents?.templateIds ?? []) : [])),
              ),
            ),
          ),
        );
        for (const document of template.documentTemplates ?? []) {
          expect(documentIds).toContain(publicTestRef({ $ref: "documentTemplate", key: document.key }));
        }
        for (const app of apps) {
          const blocks = app.pages.flatMap((page) => page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks)));
          expect(blocks.some((block) => block.type === "actions" && block.actions.some((action) => action.kind === "workflow"))).toBe(true);
          expect(blocks.some((block) => block.type === "record" && block.documents)).toBe(true);
          for (const block of blocks) {
            const navigation = block.type === "records" ? block.rowNavigate : block.type === "form" ? block.onSuccessNavigate : undefined;
            if (navigation) expect(app.pages.find((page) => page.id === navigation.pageId)?.record).toBeDefined();
          }
        }
      }
    }
  });

  test("template cards explain three concrete outcomes", () => {
    for (const template of templates) {
      expect(template.highlights).toHaveLength(3);
      expect(
        template.highlights.every((highlight) => highlight.trim().length > 0),
        `${template.id} highlights`,
      ).toBe(true);
    }
  });

  test("bookshop template is named without inventory suffix", () => {
    const bookshop = templates.find((template) => template.id === "bookshop");
    expect(bookshop?.name).toBe("Bookshop");
  });

  test("finance merchant website lookup targets usable URLs", () => {
    const finance = templates.find((template) => template.id === "finance");
    expect(finance, "finance template").toBeDefined();
    if (!finance) return;

    const transactions = finance.tables.find((table) => table.key === "transactions");
    const merchants = finance.tables.find((table) => table.key === "merchants");
    const merchantWebsite = transactions?.fields.find((field) => field.key === "merchant_website");
    const website = merchants?.fields.find((field) => field.key === "website");
    expect(merchantWebsite?.type).toBe("lookup");
    expect(website?.type).toBe("text");
    expect((merchantWebsite?.config as { targetFieldId?: unknown } | undefined)?.targetFieldId).toEqual(field("merchants.website"));

    const recentTransactions = finance.views?.find((view) => view.key === "recent_transactions");
    const columns = (recentTransactions?.ui as { columns?: Array<Record<string, unknown>> } | undefined)?.columns ?? [];
    const websiteColumn = columns.find(
      (column) => column.fieldId && isRef(column.fieldId) && column.fieldId.key === "transactions.merchant_website",
    );
    expect(websiteColumn).toEqual({
      fieldId: field("transactions.merchant_website"),
      label: "Merchant website",
    });

    const merchantRecords = (finance.records ?? []).filter((record) => record.table === "merchants");
    expect(merchantRecords.length).toBeGreaterThan(0);
    for (const record of merchantRecords) {
      expect(String(record.values.website ?? "")).toMatch(/^https?:\/\//);
    }
  });

  test("inventory template exposes asset id as a barcode field", () => {
    const inventory = templates.find((template) => template.id === "inventory");
    expect(inventory, "inventory template").toBeDefined();
    if (!inventory) return;

    const items = inventory.tables.find((table) => table.key === "items");
    const barcode = items?.fields.find((field) => field.key === "asset_barcode");
    expect(barcode?.type).toBe("formula");
    expect(barcode?.hideInTable).not.toBe(true);
    expect((barcode?.config as { expression?: unknown } | undefined)?.expression).toEqual(formula(field("items.asset_id")));
    expect((barcode?.config as { format?: unknown } | undefined)?.format).toEqual({ kind: "barcode", bcid: "code128", showText: true });

    const availableItems = inventory.views?.find((view) => view.key === "available_items");
    const columns = (availableItems?.ui as { columns?: Array<Record<string, unknown>> } | undefined)?.columns ?? [];
    const firstColumn = columns[0];
    expect(firstColumn?.fieldId).toEqual(field("items.asset_barcode"));
    expect(firstColumn?.label).toBe("Asset ID");
    expect(firstColumn?.format).toEqual({ kind: "barcode", bcid: "code128", showText: true });
  });

  test("card and calendar template examples are backed by real fields", () => {
    const bookshop = templates.find((template) => template.id === "bookshop");
    const inventory = templates.find((template) => template.id === "inventory");
    const finance = templates.find((template) => template.id === "finance");

    const books = bookshop?.tables.find((table) => table.key === "books");
    const items = inventory?.tables.find((table) => table.key === "items");
    expect((books?.displayConfig as { mode?: unknown } | undefined)?.mode).toBe("cards");
    expect((items?.displayConfig as { mode?: unknown } | undefined)?.mode).toBe("cards");

    expect((books?.displayConfig as { cards?: { imageFieldId?: unknown } } | undefined)?.cards?.imageFieldId).toEqual(field("books.cover"));
    expect((items?.displayConfig as { cards?: { imageFieldId?: unknown } } | undefined)?.cards?.imageFieldId).toEqual(field("items.files"));

    const bookCovers = (bookshop?.records ?? []).flatMap((record) => record.files ?? []);
    const inventoryCovers = (inventory?.records ?? []).flatMap((record) => record.files ?? []);
    expect(bookCovers.length, "bookshop cover sample files").toBeGreaterThan(0);
    expect(inventoryCovers.length, "inventory cover sample files").toBeGreaterThan(0);
    for (const attachment of [...bookCovers, ...inventoryCovers]) {
      const parsed = parseDataUrl(attachment.dataUrl);
      expect(parsed?.mimeType, attachment.filename).toBe("image/svg+xml");
      expect(parsed?.bytes.byteLength ?? 0, attachment.filename).toBeGreaterThan(100);
    }

    const orderCalendar = bookshop?.views?.find((view) => view.key === "order_calendar");
    const loanCalendar = inventory?.views?.find((view) => view.key === "open_loans");
    const transactionCalendar = finance?.views?.find((view) => view.key === "transaction_calendar");
    expect((orderCalendar?.ui as { displayConfig?: { mode?: unknown } } | undefined)?.displayConfig?.mode).toBe("calendar");
    expect((loanCalendar?.ui as { displayConfig?: { mode?: unknown } } | undefined)?.displayConfig?.mode).toBe("calendar");
    expect((transactionCalendar?.ui as { displayConfig?: { mode?: unknown } } | undefined)?.displayConfig?.mode).toBe("calendar");
    expect(
      (orderCalendar?.ui as { displayConfig?: { calendar?: { dateFieldId?: unknown } } } | undefined)?.displayConfig?.calendar?.dateFieldId,
    ).toEqual(field("orders.ordered_at"));
    expect(
      (loanCalendar?.ui as { displayConfig?: { calendar?: { dateFieldId?: unknown } } } | undefined)?.displayConfig?.calendar?.dateFieldId,
    ).toEqual(field("loans.due_date"));
    expect(
      (transactionCalendar?.ui as { displayConfig?: { calendar?: { dateFieldId?: unknown } } } | undefined)?.displayConfig?.calendar
        ?.dateFieldId,
    ).toEqual(field("transactions.date"));
  });

  test("calendar templates include current-month sample records", () => {
    const expectations = [
      { templateId: "bookshop", table: "orders", field: "ordered_at" },
      { templateId: "finance", table: "transactions", field: "date" },
      { templateId: "inventory", table: "loans", field: "due_date" },
    ];

    for (const expectation of expectations) {
      const template = templates.find((item) => item.id === expectation.templateId);
      const records = (template?.records ?? []).filter((record) => record.table === expectation.table);
      const currentMonthDates = records.filter((record) => isCurrentMonthDate(record.values[expectation.field]));
      expect(
        currentMonthDates.length,
        `${expectation.templateId}.${expectation.table}.${expectation.field} current-month samples`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  test("bookshop models itemized orders and invoices as business-safe resources", () => {
    const template = templates.find((item) => item.id === "bookshop");
    expect(template).toBeDefined();
    if (!template) return;

    const customers = template.tables.find((table) => table.key === "customers");
    const orders = template.tables.find((table) => table.key === "orders");
    const lines = template.tables.find((table) => table.key === "order_lines");
    expect(customers?.fields.find((item) => item.key === "email")?.required).toBe(true);
    expect(orders?.fields.some((item) => item.key === "book")).toBe(false);
    expect(orders?.fields.find((item) => item.key === "invoice_ready")?.defaultValue).toBe(false);
    expect(orders?.fields.find((item) => item.key === "invoice_sent")?.defaultValue).toEqual(["ready"]);
    expect(lines?.fields.find((item) => item.key === "unit_price")?.required).toBe(true);
    expect((lines?.fields.find((item) => item.key === "line_total")?.config as { expression?: unknown })?.expression).toEqual(
      formula(field("order_lines.quantity"), " * ", field("order_lines.unit_price")),
    );

    const orderLineRecords = (template.records ?? []).filter((item) => item.table === "order_lines");
    const lineCounts = new Map<string, number>();
    for (const item of orderLineRecords) {
      const order = refsIn(item.values.order)[0]?.key;
      if (order) lineCounts.set(order, (lineCounts.get(order) ?? 0) + 1);
    }
    expect(Math.max(...lineCounts.values())).toBeGreaterThan(1);

    const invoice = template.documentTemplates?.find((item) => item.key === "order_invoice");
    const invoiceSource = resolveTemplateGqlValue(invoice?.source, templateNamesForGql(template));
    expect(invoiceSource).toContain('from table "Order lines" as line');
    expect(invoiceSource).toContain("as invoice_unit_price");
    expect(invoiceSource).toContain("as invoice_line_total");
    expect(invoiceSource).not.toContain("limit 1");

    const workflow = template.workflows?.find((item) => item.key === "send_order_invoice")?.source ?? "";
    expect(workflow).toContain("Ready to invoice");
    expect(workflow).toContain("Invoice delivery");
    expect(workflow).toContain("Replace the sample customer email");
    expect(workflow).toContain("Invoice delivery: [sent]");
    expect(workflow.indexOf("Invoice delivery: [processing]")).toBeLessThan(workflow.indexOf("- generateDocument:"));

    const launcher = template.workflowLaunchers?.find((item) => item.key === "send_order_invoice_custom_app");
    expect(launcher?.config).toEqual({ kind: "customApp", inputMode: "prompt" });
    const orderNumberColumn = template.views
      ?.flatMap((item) => (item.ui as { columns?: Array<Record<string, unknown>> } | undefined)?.columns ?? [])
      .find((column) => isRef(column.fieldId) && column.fieldId.key === "orders.order_no");
    expect(orderNumberColumn).toEqual({ fieldId: field("orders.order_no") });
  });

  test("inventory agreement delivery requires explicit approval and is safe to replay", () => {
    const template = templates.find((item) => item.id === "inventory");
    expect(template).toBeDefined();
    if (!template) return;

    const loans = template.tables.find((table) => table.key === "loans");
    for (const key of ["requester_email", "kits", "start_date", "due_date"]) {
      expect(loans?.fields.find((item) => item.key === key)?.required, `inventory loans.${key} required`).toBe(true);
    }
    expect(loans?.fields.find((item) => item.key === "availability_confirmed")?.defaultValue).toBe(false);
    expect(loans?.fields.find((item) => item.key === "agreement_sent")?.defaultValue).toEqual(["ready"]);
    expect((loans?.fields.find((item) => item.key === "schedule_valid")?.config as { expression?: unknown })?.expression).toEqual(
      formula(field("loans.start_date"), " <= ", field("loans.due_date")),
    );
    expect(
      (template.records ?? [])
        .filter((item) => item.table === "loans")
        .some((item) => Array.isArray(item.values.status) && item.values.status[0] === "approved"),
    ).toBe(false);

    const workflow = template.workflows?.find((item) => item.key === "send_loan_agreement")?.source ?? "";
    expect(workflow).toContain("Approve this loan after checking availability");
    expect(workflow).toContain("Availability confirmed");
    expect(workflow).toContain("The due date must be on or after");
    expect(workflow).toContain("Agreement delivery: [sent]");
    expect(workflow.indexOf("Agreement delivery: [processing]")).toBeLessThan(workflow.indexOf("- generateDocument:"));
    expect(workflow).not.toContain("Status: [approved]");
    expect(workflow).toContain("Replace the sample requester email");

    const agreementLauncher = template.workflowLaunchers?.find((item) => item.key === "send_loan_agreement_custom_app");
    expect(agreementLauncher?.config).toEqual({ kind: "customApp", inputMode: "prompt" });
    const defectWorkflow = template.workflows?.find((item) => item.key === "report_item_defect")?.source ?? "";
    expect(defectWorkflow).toContain("is already in maintenance");
    expect(defectWorkflow).toContain("Status: [maintenance]");
    expect(defectWorkflow).toContain("Condition: [repair]");
    const defectLauncher = template.workflowLaunchers?.find((item) => item.key === "report_item_defect_scanner");
    expect(defectLauncher?.config).toEqual({
      kind: "scanner",
      input: "item",
      resolve: { by: "field", field: "Asset ID" },
    });
    expect(template.documentTemplates?.find((item) => item.key === "asset_label")).toMatchObject({
      table: "items",
      starterId: "label",
      name: "Asset label",
      enabled: true,
    });

    const valueWidget = customAppBlocks(template).find((cell) => cell.id === "w-value");
    expect(valueWidget).toMatchObject({
      type: "metrics",
      title: "Inventory value",
    });
    const openLoans = template.views?.find((item) => item.key === "open_loans");
    expect((openLoans?.ui as { columns?: Array<Record<string, unknown>> })?.columns?.[0]).toEqual({
      fieldId: field("loans.loan_no"),
    });
  });

  test("finance workflows start from pending transactions and budget only the current month", () => {
    const template = templates.find((item) => item.id === "finance");
    expect(template).toBeDefined();
    if (!template) return;

    const transactions = template.tables.find((table) => table.key === "transactions");
    for (const key of ["date", "merchant", "account", "category", "type", "amount", "receipt_email"]) {
      expect(transactions?.fields.find((item) => item.key === key)?.required, `finance transactions.${key} required`).toBe(true);
    }
    expect(transactions?.fields.find((item) => item.key === "cleared")?.defaultValue).toBe(false);
    expect(transactions?.fields.find((item) => item.key === "receipt_sent")?.defaultValue).toEqual(["ready"]);

    const formFields = (template.forms?.find((item) => item.key === "log_expense")?.config.fields ?? []) as Array<Record<string, unknown>>;
    expect(
      formFields.find((item) => item.kind === "form_value" && isRef(item.fieldId) && item.fieldId.key === "transactions.cleared")?.value,
    ).toBe(false);
    expect(
      formFields.find((item) => item.kind === "form_value" && isRef(item.fieldId) && item.fieldId.key === "transactions.receipt_sent")
        ?.value,
    ).toEqual(["ready"]);

    const workflow = template.workflows?.find((item) => item.key === "clear_and_send_receipt")?.source ?? "";
    expect(workflow).toContain("Receipts can only be sent for expense transactions");
    expect(workflow).toContain("Receipt delivery: [sent]");
    expect(workflow.indexOf("Receipt delivery: [processing]")).toBeLessThan(workflow.indexOf("- generateDocument:"));
    expect(workflow).toContain("Replace the sample receipt email");
    const launcher = template.workflowLaunchers?.find((item) => item.key === "clear_and_send_receipt_custom_app");
    expect(launcher?.config).toEqual({ kind: "customApp", inputMode: "prompt" });

    const budgetWidget = customAppBlocks(template).find((cell) => cell.id === "w-budget");
    const budgetSource = resolveTemplateGqlValue(
      (budgetWidget?.source as { query?: unknown } | undefined)?.query,
      templateNamesForGql(template),
    );
    expect(budgetSource).toContain("YEAR(TODAY())");
    expect(budgetSource).toContain("MONTH(TODAY())");
    expect((template.records ?? []).some((item) => item.key === "budgets.previous_groceries")).toBe(true);

    const recentTransactions = template.views?.find((item) => item.key === "recent_transactions");
    expect((recentTransactions?.ui as { columns?: Array<Record<string, unknown>> })?.columns?.[0]).toEqual({
      fieldId: field("transactions.transaction_ref"),
    });
  });

  test("scanner examples use durable physical identifiers", () => {
    const scanners = templates.flatMap((template) =>
      (template.workflowLaunchers ?? [])
        .filter((launcher) => launcher.config.kind === "scanner")
        .map((launcher) => ({ template: template.id, key: launcher.key, config: launcher.config })),
    );

    expect(scanners).toEqual([
      {
        template: "inventory",
        key: "report_item_defect_scanner",
        config: { kind: "scanner", input: "item", resolve: { by: "field", field: "Asset ID" } },
      },
      {
        template: "inventory",
        key: "return_loan_item_scanner",
        config: {
          kind: "scanner",
          inputSources: {
            item: { kind: "scan", value: "record", resolve: { by: "field", field: "Asset ID" } },
            condition: { kind: "afterScan" },
          },
        },
      },
    ]);
  });

  test("form input entries include help text", () => {
    for (const template of templates) {
      for (const form of template.forms ?? []) {
        const fields = (form.config as { fields?: unknown }).fields;
        expect(Array.isArray(fields), `${template.id}.${form.key} fields`).toBe(true);

        for (const entry of fields as Array<Record<string, unknown>>) {
          if (entry.kind !== "user_input") continue;
          expect(
            typeof entry.helpText === "string" && entry.helpText.trim().length > 0,
            `${template.id}.${form.key}.${String(entry.fieldId)} helpText`,
          ).toBe(true);

          const inlineFields = (entry.inlineCreate as { fields?: unknown } | undefined)?.fields;
          if (!Array.isArray(inlineFields)) continue;
          for (const inlineEntry of inlineFields as Array<Record<string, unknown>>) {
            expect(
              typeof inlineEntry.helpText === "string" && inlineEntry.helpText.trim().length > 0,
              `${template.id}.${form.key}.${String(entry.fieldId)} inline ${String(inlineEntry.fieldId)} helpText`,
            ).toBe(true);
          }
        }
      }
    }
  });

  test("all internal references resolve", () => {
    for (const template of templates) {
      const index = indexTemplate(template);
      const tablesByKey = new Map(template.tables.map((table) => [table.key, table]));
      const recordsByKey = new Map((template.records ?? []).map((record) => [record.key, record]));
      assertUnique(
        template.tables.map((table) => table.key),
        `${template.id} table keys`,
      );
      assertUnique(
        template.tables.map((table) => table.name),
        `${template.id} table names`,
      );

      for (const table of template.tables) {
        assertUnique(
          table.fields.map((field) => field.key),
          `${template.id}.${table.key} field keys`,
        );
        assertUnique(
          table.fields.map((field) => field.name),
          `${template.id}.${table.key} field names`,
        );
      }

      for (const ref of refsIn(template)) {
        const target =
          ref.$ref === "table"
            ? index.tables
            : ref.$ref === "field"
              ? index.fields
              : ref.$ref === "record"
                ? index.records
                : ref.$ref === "view"
                  ? index.views
                  : ref.$ref === "form"
                    ? index.forms
                    : ref.$ref === "documentTemplate"
                      ? index.documentTemplates
                      : index.launchers;
        expect(target.has(ref.key), `${template.id} missing ${ref.$ref}:${ref.key}`).toBe(true);
      }

      assertUnique(
        (template.records ?? []).map((record) => record.key),
        `${template.id} record keys`,
      );
      assertUnique(
        (template.views ?? []).map((view) => view.key),
        `${template.id} view keys`,
      );
      assertUnique(
        (template.views ?? []).map((view) => view.name),
        `${template.id} view names`,
      );
      assertUnique(
        (template.forms ?? []).map((form) => form.key),
        `${template.id} form keys`,
      );
      assertUnique(
        (template.forms ?? []).map((form) => form.name),
        `${template.id} form names`,
      );
      assertUnique(
        (template.customApps ?? []).map((app) => app.key),
        `${template.id} Grids App keys`,
      );
      assertUnique(
        (template.customApps ?? []).map((app) => app.definition.name as string),
        `${template.id} Grids App names`,
      );
      assertUnique(
        (template.documentTemplates ?? []).map((documentTemplate) => documentTemplate.key),
        `${template.id} document template keys`,
      );
      assertUnique(
        (template.documentTemplates ?? []).map((documentTemplate) => documentTemplate.name ?? documentTemplate.starterId),
        `${template.id} document template names`,
      );
      assertUnique(
        (template.emailTemplates ?? []).map((emailTemplate) => emailTemplate.key),
        `${template.id} email template keys`,
      );
      assertUnique(
        (template.emailTemplates ?? []).map((emailTemplate) => emailTemplate.name),
        `${template.id} email template names`,
      );
      assertUnique(
        (template.workflows ?? []).map((workflow) => workflow.key),
        `${template.id} workflow keys`,
      );
      assertUnique(
        (template.workflows ?? []).map((workflow) => workflow.name),
        `${template.id} workflow names`,
      );
      assertUnique(
        (template.workflowLaunchers ?? []).map((launcher) => launcher.key),
        `${template.id} workflow launcher keys`,
      );
      assertUnique(
        (template.workflowLaunchers ?? []).map((launcher) => launcher.name),
        `${template.id} workflow launcher names`,
      );

      for (const record of template.records ?? []) {
        const recordTable = tablesByKey.get(record.table);
        expect(recordTable, `${template.id}.${record.key} table`).toBeDefined();
        if (!recordTable) continue;
        const fieldsByKey = new Map(recordTable.fields.map((field) => [field.key, field]));

        for (const [fieldKey, value] of Object.entries(record.values)) {
          const recordField = fieldsByKey.get(fieldKey);
          expect(recordField, `${template.id}.${record.key}.${fieldKey} field`).toBeDefined();
          if (!recordField) continue;

          const relatedRecords = refsIn(value).filter((ref) => ref.$ref === "record");
          if (relatedRecords.length === 0) continue;
          expect(recordField.type, `${template.id}.${record.key}.${fieldKey} record refs require relation field`).toBe("relation");
          const targetTable = (recordField.config as { targetTableId?: unknown } | undefined)?.targetTableId;
          expect(isRef(targetTable) && targetTable.$ref === "table", `${template.id}.${record.key}.${fieldKey} relation target`).toBe(true);
          if (!isRef(targetTable) || targetTable.$ref !== "table") continue;
          for (const relatedRecord of relatedRecords) {
            expect(recordsByKey.get(relatedRecord.key)?.table, `${template.id}.${record.key}.${fieldKey} relation target record`).toBe(
              targetTable.key,
            );
          }
        }

        for (const attachment of record.files ?? []) {
          expect(fieldsByKey.get(attachment.field)?.type, `${template.id}.${record.key}.${attachment.field} file field`).toBe("file");
        }
      }

      for (const resource of [...(template.views ?? []), ...(template.forms ?? []), ...(template.documentTemplates ?? [])]) {
        expect(tablesByKey.has(resource.table), `${template.id}.${resource.key} owner table`).toBe(true);
      }

      for (const form of template.forms ?? []) {
        const fields = (form.config as { fields?: unknown }).fields;
        if (!Array.isArray(fields)) continue;
        const ownerTable = tablesByKey.get(form.table);
        const ownerFields = new Map(ownerTable?.fields.map((field) => [field.key, field]) ?? []);

        for (const entry of fields as Array<Record<string, unknown>>) {
          const fieldRef = entry.fieldId;
          expect(
            isRef(fieldRef) && fieldRef.$ref === "field" && fieldRef.key.startsWith(`${form.table}.`),
            `${template.id}.${form.key} field belongs to form table`,
          ).toBe(true);
          if (!isRef(fieldRef) || fieldRef.$ref !== "field") continue;

          const inlineFields = (entry.inlineCreate as { fields?: unknown } | undefined)?.fields;
          if (!Array.isArray(inlineFields)) continue;
          const relationField = ownerFields.get(fieldRef.key.slice(form.table.length + 1));
          const targetTable = (relationField?.config as { targetTableId?: unknown } | undefined)?.targetTableId;
          expect(relationField?.type, `${template.id}.${form.key}.${fieldRef.key} inline relation`).toBe("relation");
          expect(isRef(targetTable) && targetTable.$ref === "table", `${template.id}.${form.key}.${fieldRef.key} inline target table`).toBe(
            true,
          );
          if (!isRef(targetTable) || targetTable.$ref !== "table") continue;

          for (const inlineEntry of inlineFields as Array<Record<string, unknown>>) {
            const inlineFieldRef = inlineEntry.fieldId;
            expect(
              isRef(inlineFieldRef) && inlineFieldRef.$ref === "field" && inlineFieldRef.key.startsWith(`${targetTable.key}.`),
              `${template.id}.${form.key}.${fieldRef.key} inline field belongs to relation target`,
            ).toBe(true);
          }
        }
      }

      const workflowKeys = new Set((template.workflows ?? []).map((workflow) => workflow.key));
      for (const launcher of template.workflowLaunchers ?? []) {
        expect(workflowKeys.has(launcher.workflow), `${template.id}.${launcher.key} workflow`).toBe(true);
      }
    }
  });

  test("each template has meaningful Grids App charts", () => {
    for (const template of templates) {
      const viewsByKey = new Map((template.views ?? []).map((view) => [view.key, view]));
      const charts = customAppBlocks(template).filter((block) => block.type === "chart");
      expect(charts.length, `${template.id} Grids App charts`).toBeGreaterThan(0);

      for (const chart of charts) {
        const source = chart.source;
        const isViewSource = typeof source === "object" && source !== null && "kind" in source && source.kind === "view";
        const isGqlSource = typeof source === "object" && source !== null && "kind" in source && source.kind === "gql";
        expect(isViewSource || isGqlSource, `${template.id}.${String(chart.id)} source kind`).toBe(true);

        let gql = "";
        if (isViewSource && "viewId" in source) {
          const viewId = source.viewId;
          expect(isRef(viewId) && viewId.$ref === "view", `${template.id}.${String(chart.id)} view ref`).toBe(true);
          if (!isRef(viewId)) continue;
          const view = viewsByKey.get(viewId.key);
          expect(view, `${template.id}.${String(chart.id)} chart view exists`).toBeDefined();
          gql = String(resolveTemplateGqlValue(view?.source ?? "", templateNamesForGql(template)));
        } else if (isGqlSource && "query" in source) {
          gql = String(resolveTemplateGqlValue(source.query, templateNamesForGql(template)));
        }

        expect(gql, `${template.id}.${String(chart.id)} chart groupBy`).toContain("group by");
        expect(gql, `${template.id}.${String(chart.id)} chart aggregations`).toContain("aggregate");
        const valueFormat = chart.valueFormat as { unit?: unknown } | undefined;
        if (valueFormat?.unit === "EUR") {
          expect(gql, `${template.id}.${String(chart.id)} EUR chart value field`).toMatch(
            /aggregate[^\n]*(?:sum|avg|median|min|max|earliest|latest)\(/,
          );
        }
      }
    }
  });

  test("template views provide resolvable GQL sources", () => {
    for (const template of templates) {
      const names = templateNamesForGql(template);
      const ctx = templateTestContext(template);
      for (const view of template.views ?? []) {
        const source = resolveTemplateGqlValue(view.source ?? "", names);
        expect(typeof source).toBe("string");
        expect(String(source), `${template.id}.${view.key} should use readable refs`).not.toMatch(
          /\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}/i,
        );
        const parsed = parseGridsQueryDsl(String(source));
        expect(parsed.ok, `${template.id}.${view.key} parses as GQL`).toBe(true);
        if (!parsed.ok) continue;
        const resolved = resolveDslQueryToQueryPlan(parsed.ast, templateResolverContext(template, view.table, ctx));
        expect(
          resolved.ok,
          `${template.id}.${view.key} resolves as GQL: ${resolved.ok ? "" : resolved.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
        ).toBe(true);
      }
    }
  });

  test("template resources pass the same write schemas used during creation", async () => {
    for (const template of [...templates, ...getTemplates("de")]) {
      const ctx = templateTestContext(template);

      expect(
        CreateBaseSchema.safeParse({
          name: template.baseName,
          description: template.baseDescription ?? template.description,
        }).success,
        `${template.id} base payload`,
      ).toBe(true);

      for (const table of template.tables) {
        const displayConfig = resolveTestValue(table.displayConfig, ctx);
        expect(
          CreateTableSchema.safeParse({
            name: table.name,
            description: table.description ?? null,
            displayConfig,
          }).success,
          `${template.id}.${table.key} table payload`,
        ).toBe(true);
        if (displayConfig !== undefined) {
          expect(RecordDisplayConfigSchema.safeParse(displayConfig).success, `${template.id}.${table.key} display config`).toBe(true);
        }

        for (const templateField of table.fields) {
          const config = resolveTestValue(templateField.config ?? {}, ctx);
          const defaultValue = resolveTestValue(templateField.defaultValue, ctx);
          const fieldType = fieldTypeRegistry[templateField.type];
          expect(fieldType, `${template.id}.${table.key}.${templateField.key} field type`).toBeDefined();
          expect(
            CreateFieldSchema.safeParse({
              name: templateField.name,
              description: templateField.description ?? null,
              icon: templateField.icon ?? null,
              type: templateField.type,
              config,
              required: templateField.required,
              presentable: templateField.presentable,
              hideInTable: templateField.hideInTable,
              defaultValue,
              indexed: templateField.indexed,
              uniqueConstraint: templateField.uniqueConstraint,
            }).success,
            `${template.id}.${table.key}.${templateField.key} field payload`,
          ).toBe(true);
          if (!fieldType) continue;

          const parsedConfig = fieldType.configSchema.safeParse(config);
          expect(parsedConfig.success, `${template.id}.${table.key}.${templateField.key} field config`).toBe(true);

          const writableType = getRecordWritableFieldType(templateField.type);
          if (writableType && defaultValue !== undefined) {
            expect(
              writableType.validate(defaultValue, parsedConfig.success ? parsedConfig.data : config, templateField.required === true).ok,
              `${template.id}.${table.key}.${templateField.key} default value`,
            ).toBe(true);
          }
        }
      }

      for (const view of template.views ?? []) {
        const source = resolveTemplateGqlValue(view.source ?? `from table ${view.table}`, templateNamesForGql(template));
        const ui = resolveTestValue(view.ui ?? {}, ctx);
        expect(
          CreateViewSchema.safeParse({
            name: view.name,
            source,
            ui,
            shared: view.shared,
          }).success,
          `${template.id}.${view.key} view payload`,
        ).toBe(true);
        expect(ViewUiSettingsSchema.safeParse(ui).success, `${template.id}.${view.key} view ui`).toBe(true);
      }

      for (const form of template.forms ?? []) {
        const config = resolveTestValue(form.config, ctx);
        expect(FormConfigSchema.safeParse(config).success, `${template.id}.${form.key} form config`).toBe(true);
      }

      for (const app of template.customApps ?? []) {
        const resolvedDefinition = resolveTestCustomAppValue(app.definition, ctx) as Record<string, unknown>;
        const checkedDefinition = CustomAppDefinitionSchema.safeParse({ ...resolvedDefinition, id: "APP001", baseId: "BASE01" });
        expect(
          checkedDefinition.success,
          `${template.id}.${app.key} canonical Grids App definition: ${checkedDefinition.success ? "" : checkedDefinition.error.message}`,
        ).toBe(true);
        const page = app.definition.pages[0]!;
        assertUnique(
          page.rows.map((row) => row.id as string),
          `${template.id}.${app.key} Grids App row ids`,
        );
        assertUnique(
          page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks.map((block) => block.id as string))),
          `${template.id}.${app.key} Grids App block ids`,
        );
        for (const row of page.rows) {
          expect(
            row.columns.reduce((total, column) => total + column.span, 0),
            `${template.id}.${app.key}.${row.id} spans`,
          ).toBeLessThanOrEqual(12);
          for (const column of row.columns) {
            expect(column.span, `${template.id}.${app.key}.${column.id} span`).toBeGreaterThanOrEqual(1);
            expect(column.span, `${template.id}.${app.key}.${column.id} span`).toBeLessThanOrEqual(12);
            resolveTestValue(column, ctx);

            for (const block of column.blocks) {
              if (
                "source" in block &&
                block.source &&
                typeof block.source === "object" &&
                (block.source as { kind?: unknown }).kind === "gql"
              ) {
                const gql = resolveTemplateGqlValue((block.source as { query?: unknown }).query, templateNamesForGql(template));
                expect(typeof gql, `${template.id}.${app.key}.${block.id} Grids App GQL`).toBe("string");
                if (typeof gql !== "string") continue;
                const parsed = parseGridsQueryDsl(gql);
                expect(parsed.ok, `${template.id}.${app.key}.${block.id} Grids App GQL parses`).toBe(true);
                if (!parsed.ok) continue;
                const bound = bindDslQueryContext(parsed.ast, {
                  "auth.id": testUuid(20_000),
                  "auth.subjects": [testUuid(20_000)],
                  "time.today": "2026-06-15",
                  "time.now": "2026-06-15T12:00:00.000Z",
                  "time.timeZone": "UTC",
                  ...Object.fromEntries(
                    Object.keys(app.definition.pages.find((page) => page.id === app.definition.startPageId)?.parameters ?? {}).map(
                      (key) => [`params.${key}`, testUuid(20_001)],
                    ),
                  ),
                });
                expect(bound.ok, `${template.id}.${app.key}.${block.id} Grids App GQL context`).toBe(true);
                if (!bound.ok) continue;
                const resolved = resolveDslQueryToQueryPlan(
                  bound.ast,
                  templateResolverContext(template, template.tables[0]?.key ?? "", ctx),
                );
                expect(
                  resolved.ok,
                  `${template.id}.${app.key}.${block.id} Grids App GQL resolves: ${
                    resolved.ok ? "" : resolved.diagnostics.map((diagnostic) => diagnostic.message).join("; ")
                  }`,
                ).toBe(true);
              }
            }
          }
        }
      }

      const documentTemplateEntries: Array<{ id: string; shortId: string; tableId: string; name: string }> = [];
      for (const [index, documentTemplate] of (template.documentTemplates ?? []).entries()) {
        const tableId = ctx.tables.get(documentTemplate.table);
        const starter = documentTemplateStarterById(documentTemplate.starterId);
        expect(tableId, `${template.id}.${documentTemplate.key} table`).toBeDefined();
        expect(starter, `${template.id}.${documentTemplate.key} starter`).toBeDefined();
        if (!tableId || !starter) throw new Error(`invalid document template ${template.id}.${documentTemplate.key}`);
        const sourceValue = resolveTemplateGqlValue(documentTemplate.source ?? starter.source(tableId), templateNamesForGql(template));
        expect(typeof sourceValue, `${template.id}.${documentTemplate.key} document source`).toBe("string");
        if (typeof sourceValue !== "string") throw new Error(`invalid document source ${template.id}.${documentTemplate.key}`);
        const source = sourceValue;
        const payload = {
          name: documentTemplate.name ?? starter.name,
          description: documentTemplate.description === undefined ? starter.description : documentTemplate.description,
          source,
          renderer: starter.renderer,
          enabled: documentTemplate.enabled,
        };
        expect(CreateDocumentTemplateSchema.safeParse(payload).success, `${template.id}.${documentTemplate.key} document payload`).toBe(
          true,
        );
        expect(validateTemplateWrite(payload).ok, `${template.id}.${documentTemplate.key} document Liquid`).toBe(true);
        if (documentTemplate.starterId === "loan-agreement") {
          const rendered = await renderDocumentHtml(
            { renderer: starter.renderer },
            {
              app: { name: "Cloud" },
              business: { legalName: "Example Operations", senderLine: "Example Operations", address: "Example Street 1" },
              document: { number: "LN-2026-001" },
              rows: [
                {
                  borrower_name: "Mara Example",
                  borrower_organization: "Example Studio",
                  borrower_email: "mara@example.test",
                  loan_start: "2026-07-10",
                  return_due: "2026-07-17",
                },
              ],
              columns: [
                { key: "borrower_name", label: "Borrower name" },
                { key: "borrower_organization", label: "Borrower organization" },
                { key: "borrower_email", label: "Borrower email" },
                { key: "loan_start", label: "Loan starts" },
                { key: "return_due", label: "Return due" },
              ],
            },
          );
          expect(
            rendered.ok,
            `${template.id}.${documentTemplate.key} renders contract data: ${rendered.ok ? "" : rendered.error.message}`,
          ).toBe(true);
          if (!rendered.ok) throw new Error(rendered.error.message);
          expect(rendered.data).toContain("Mara Example");
          expect(rendered.data).toContain("Example Studio");
          expect(rendered.data).toContain("2026-07-10");
          expect(rendered.data).toContain("2026-07-17");
        }
        expect(String(source), `${template.id}.${documentTemplate.key} should use readable GQL refs`).not.toMatch(
          /\{[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\}/i,
        );
        const renderedSource = await renderDocumentSource({ source }, { record: { id: `R${String(index).padStart(5, "0")}` } });
        expect(renderedSource.ok, `${template.id}.${documentTemplate.key} renders document GQL`).toBe(true);
        if (!renderedSource.ok) throw new Error(renderedSource.error.message);
        const parsed = parseGridsQueryDsl(renderedSource.data);
        expect(parsed.ok, `${template.id}.${documentTemplate.key} parses as GQL`).toBe(true);
        if (parsed.ok) {
          const resolved = resolveDslQueryToQueryPlan(parsed.ast, templateResolverContext(template, documentTemplate.table, ctx));
          expect(
            resolved.ok,
            `${template.id}.${documentTemplate.key} resolves as GQL: ${resolved.ok ? "" : resolved.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
          ).toBe(true);
        }
        documentTemplateEntries.push({
          id: testUuid(10_000 + index),
          shortId: documentTemplate.key,
          tableId,
          name: payload.name,
        });
      }

      const emailTemplateEntries: Array<{ id: string; shortId: string; name: string }> = [];
      for (const [index, emailTemplate] of (template.emailTemplates ?? []).entries()) {
        expect(CreateEmailTemplateSchema.safeParse(emailTemplate).success, `${template.id}.${emailTemplate.key} email payload`).toBe(true);
        expect(validateEmailTemplateWrite(emailTemplate).ok, `${template.id}.${emailTemplate.key} email Liquid`).toBe(true);
        const rendered = await renderEmailTemplate(emailTemplate, {
          data: emailTemplate.sampleData ?? {},
          app: { name: "Cloud", logoSvgDataUrl: "https://cloud.example.org/logo.svg" },
          business: { legalName: "ACME Operations GmbH", senderLine: "ACME Operations GmbH · Berlin" },
          workflow: { name: "Example workflow" },
          run: { id: testUuid(21_000 + index) },
          date: { iso: "2026-07-24" },
        });
        expect(
          rendered.ok,
          `${template.id}.${emailTemplate.key} renders with its stored sample data: ${rendered.ok ? "" : rendered.error.message}`,
        ).toBe(true);
        emailTemplateEntries.push({
          id: testUuid(20_000 + index),
          shortId: emailTemplate.key,
          name: emailTemplate.name,
        });
      }

      const workflowCatalog = buildWorkflowCatalog({
        tables: template.tables.map((table) => ({
          id: ctx.tables.get(table.key) ?? "",
          shortId: table.key,
          name: table.name,
          kind: "stored",
        })),
        fieldsByTable: new Map(
          template.tables.map((table) => [
            ctx.tables.get(table.key) ?? "",
            table.fields.map((templateField) => ({
              id: ctx.fields.get(`${table.key}.${templateField.key}`) ?? "",
              shortId: templateField.key,
              name: templateField.name,
              ...(templateField.type === "relation" && isRef(templateField.config?.targetTableId)
                ? {
                    relation: {
                      targetTableId: ctx.tables.get(templateField.config.targetTableId.key)!,
                      cardinality: templateField.config?.cardinality === "single" ? ("single" as const) : ("multiple" as const),
                    },
                  }
                : {}),
            })),
          ]),
        ),
        templates: documentTemplateEntries,
        emailTemplates: emailTemplateEntries,
      });
      for (const workflow of template.workflows ?? []) {
        expect(CreateGridsWorkflowSchema.safeParse(workflow).success, `${template.id}.${workflow.key} workflow payload`).toBe(true);
        const compiled = await compileWorkflow(workflow.source, gridsWorkflows);
        expect(
          compiled.ok,
          `${template.id}.${workflow.key} workflow YAML: ${compiled.ok ? "" : compiled.diagnostics.map((item) => item.message).join("; ")}`,
        ).toBe(true);
        if (!compiled.ok) continue;
        const bound = await bindGridsWorkflow(compiled.ir, workflowCatalog);
        expect(
          bound.ok,
          `${template.id}.${workflow.key} workflow YAML: ${bound.ok ? "" : bound.diagnostics.map((item) => item.message).join("; ")}`,
        ).toBe(true);
      }

      const workflowsByKey = new Map((template.workflows ?? []).map((workflow) => [workflow.key, workflow]));
      for (const launcher of template.workflowLaunchers ?? []) {
        const workflow = workflowsByKey.get(launcher.workflow);
        expect(workflow, `${template.id}.${launcher.key} launcher workflow`).toBeDefined();
        if (!workflow) continue;
        const compiled = await compileWorkflow(workflow.source, gridsWorkflows);
        expect(compiled.ok, `${template.id}.${launcher.key} launcher workflow compiles`).toBe(true);
        if (!compiled.ok) continue;
        const bound = await bindGridsWorkflow(compiled.ir, workflowCatalog);
        expect(bound.ok, `${template.id}.${launcher.key} launcher workflow binds`).toBe(true);
        if (!bound.ok) continue;
        expect(
          validateLauncherConfig({ plan: bound.plan } as Parameters<typeof validateLauncherConfig>[0], launcher.config),
          `${template.id}.${launcher.key} launcher config`,
        ).toEqual([]);

        // `validateLauncherConfig` only asks whether the named input exists and
        // has the right type. A scanner also reads a field by name at scan
        // time, and refuses one without a unique constraint — so renaming that
        // field in the table definition breaks the scanner in every base built
        // from this template while everything above still passes.
        const config = launcher.config;
        if (config.kind !== "scanner") continue;
        const scanned = Object.entries(scannerLauncherInputSources(config)).find(
          ([, source]) => source.kind === "scan" && source.value === "record",
        );
        if (!scanned) continue;
        const [scannedInputName, source] = scanned;
        if (source.kind !== "scan" || source.value !== "record" || source.resolve.by !== "field") continue;
        const scannedInput = bound.plan.inputs.find((item) => item.name === scannedInputName);
        const tableName = typeof scannedInput?.config.table === "string" ? scannedInput.config.table : "";
        const scannedTable = template.tables.find((item) => item.name === tableName);
        expect(scannedTable, `${template.id}.${launcher.key} scanner table "${tableName}"`).toBeDefined();
        const scannedField = scannedTable?.fields.find((item) => item.name === source.resolve.field);
        expect(scannedField, `${template.id}.${launcher.key} scanner field "${source.resolve.field}"`).toBeDefined();
        // An `id` field is given a unique constraint when it is created.
        expect(
          scannedField?.type === "id" || scannedField?.uniqueConstraint === true,
          `${template.id}.${launcher.key} scanner field "${source.resolve.field}" must enforce unique values`,
        ).toBe(true);
      }
    }
  }, 20_000);

  test("template fields use polished labels and descriptions", () => {
    for (const template of templates) {
      for (const label of labelsIn(template)) {
        expect(label.trim().length, `${template.id} UI label`).toBeGreaterThan(0);
        expect(label.includes("_"), `${template.id} UI label must not expose snake_case: ${label}`).toBe(false);
      }

      for (const table of template.tables) {
        expect(table.name.trim().length, `${template.id}.${table.key} table name`).toBeGreaterThan(0);
        expect(table.name.includes("_"), `${template.id}.${table.key} table label must not expose snake_case`).toBe(false);

        const presentableFields = table.fields.filter((field) => field.presentable);
        expect(presentableFields.length, `${template.id}.${table.key} presentable field`).toBeGreaterThan(0);

        for (const field of table.fields) {
          expect(
            typeof field.description === "string" && field.description.trim().length > 0,
            `${template.id}.${table.key}.${field.key} description`,
          ).toBe(true);
          expect(field.name.trim().length, `${template.id}.${table.key}.${field.key} label`).toBeGreaterThan(0);
          expect(field.name.includes("_"), `${template.id}.${table.key}.${field.key} label must not expose snake_case`).toBe(false);
          expect(field.icon?.trim().length, `${template.id}.${table.key}.${field.key} icon`).toBeGreaterThan(0);
          if (field.required !== undefined)
            expect(typeof field.required, `${template.id}.${table.key}.${field.key} required flag`).toBe("boolean");
        }
      }
    }
  });
});
