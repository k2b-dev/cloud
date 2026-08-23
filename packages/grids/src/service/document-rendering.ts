import { Buffer } from "node:buffer";
import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import {
  type GotenbergConfig,
  type RenderHtmlToPdfResult,
  renderTemplatePdfPreview,
  type TemplatePdfPreviewResult,
} from "@valentinkolb/cloud/services";
import { type Document, type DocumentTemplate, DocumentTemplateRendererSchema } from "../contracts";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { previewDslQuery } from "../query-dsl/preview";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { collectDslPlanExtraFieldTableIds } from "../query-dsl/source-plan";
import {
  datePatternContext,
  documentLiquidFilters,
  documentNumberFor,
  renderLiquidPlainText,
  renderLiquidText,
  templatePatternContext,
} from "./document-liquid";
import type { RecordSnapshotDraft, SnapshotRecord } from "./document-snapshots";
import { normalizeDocumentTags, safePdfFilename } from "./document-values";
import { listByTable as listFields } from "./fields";
import { getContent as getFileContent, listForRecordField } from "./files";
import { buildTrustedGqlResolverContext } from "./gql-resolver-context";
import { projectPublicIds } from "./public-resource-ids";
import { ensureRecordScanCode } from "./record-scan-codes";
import {
  buildTemplateAppData,
  buildTemplateBusinessData,
  type DocumentTemplateAppData,
  type DocumentTemplateBusinessData,
  defaultTemplateAppData,
} from "./template-context";
import type { Field, GridRecord, Table } from "./types";

export { buildTemplateAppData, buildTemplateBusinessData } from "./template-context";

const SOURCE_MAX_BYTES = 20_000;
const FILENAME_TEMPLATE_MAX_BYTES = 5_000;
const TEMPLATE_PART_MAX_BYTES = 50_000;
const RENDER_MAX_BYTES = 300_000;
const DOCUMENT_QUERY_MAX_ROWS = 10_000;
const DOCUMENT_IMAGE_MAX_BYTES = 2_000_000;
const DOCUMENT_IMAGE_MAX_COUNT = 12;

type DocumentTemplateRecordContext = Pick<GridRecord, "id" | "shortId" | "tableId" | "version" | "data" | "createdAt" | "updatedAt">;
type DocumentTemplateTableContext = Pick<Table, "id" | "shortId" | "name">;
type DocumentTemplateRecordMeta = {
  scan?: {
    code: string;
    qrText: string;
  };
};

type DocumentTemplateImage = {
  fieldId: string;
  fieldName: string;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
};

const buildRecordScanMeta = async (params: { baseId: string; tableId: string; recordId: string }): Promise<DocumentTemplateRecordMeta> => {
  const scan = await ensureRecordScanCode({
    baseId: params.baseId,
    tableId: params.tableId,
    recordId: params.recordId,
  });
  return {
    scan: {
      code: scan.code,
      qrText: scan.code,
    },
  };
};

const recordContextWithMeta = <T extends DocumentTemplateRecordContext | SnapshotRecord>(
  record: T,
  meta: DocumentTemplateRecordMeta = {},
): T & { meta: DocumentTemplateRecordMeta } => ({
  ...record,
  meta,
});

export const documentRecordDataWithPublicIds = (
  data: Record<string, unknown>,
  fields: Field[],
  recordIds: ReadonlyMap<string, string>,
): Record<string, unknown> =>
  Object.fromEntries(
    fields.flatMap((field) => {
      if (!(field.id in data)) return [];
      const value = data[field.id];
      const projected =
        field.type === "relation"
          ? Array.isArray(value)
            ? value.map((id) => (typeof id === "string" ? (recordIds.get(id) ?? null) : id))
            : typeof value === "string"
              ? (recordIds.get(value) ?? null)
              : value
          : value;
      return [[field.shortId, projected] as const];
    }),
  );

const diagnosticsMessage = (diagnostics: Array<{ message: string }>): string =>
  diagnostics.map((diagnostic) => diagnostic.message).join("; ") || "invalid GQL source";

type DocumentColumn = { key?: unknown; label?: unknown };

export const rowsWithColumnLabels = (columns: unknown[], rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
  const usableColumns = columns.filter(
    (column): column is { key: string; label: string } =>
      typeof (column as DocumentColumn).key === "string" && typeof (column as DocumentColumn).label === "string",
  );
  return rows.map((row) => {
    const next = { ...row };
    for (const column of usableColumns) {
      if (next[column.label] === undefined) next[column.label] = row[column.key];
    }
    return next;
  });
};

const fieldsWithPlanExtras = async (
  fieldsByTableId: Record<string, Field[]>,
  tableId: string,
  plan: Parameters<typeof collectDslPlanExtraFieldTableIds>[0],
): Promise<Record<string, Field[]>> => {
  const missing = collectDslPlanExtraFieldTableIds(plan).filter((extraTableId) => fieldsByTableId[extraTableId] === undefined);
  if (fieldsByTableId[tableId] === undefined) missing.push(tableId);
  if (missing.length === 0) return fieldsByTableId;
  const groups = await Promise.all(
    [...new Set(missing)].map(async (missingTableId) => ({ tableId: missingTableId, fields: await listFields(missingTableId) })),
  );
  return { ...fieldsByTableId, ...Object.fromEntries(groups.map((group) => [group.tableId, group.fields])) };
};

const executeDocumentGqlSource = async (params: {
  baseId: string;
  tableId: string;
  source: string;
  dateConfig?: DateContext;
}): Promise<Result<{ columns: unknown[]; rows: Array<Record<string, unknown>> }>> => {
  const parsed = parseGridsQueryDsl(params.source);
  if (!parsed.ok) return fail(err.badInput(diagnosticsMessage(parsed.diagnostics)));

  const ctx = await buildTrustedGqlResolverContext({
    baseId: params.baseId,
    currentTableId: params.tableId,
    ast: parsed.ast,
    purpose: "document-template-render",
  });
  const resolved = resolveDslQueryToQueryPlan(parsed.ast, ctx);
  if (!resolved.ok) return fail(err.badInput(diagnosticsMessage(resolved.diagnostics)));

  const fieldsByTableId = await fieldsWithPlanExtras(ctx.fieldsByTableId, params.tableId, resolved.plan);
  const preview = await previewDslQuery(resolved.plan, {
    fieldsByTableId,
    timeZone: params.dateConfig?.timeZone,
    maxRows: DOCUMENT_QUERY_MAX_ROWS,
    // A document template is a deliberate data-product boundary. Its admin
    // chooses the stored GQL; readers can consume that output without source
    // table access, but cannot substitute GQL on this trusted execution path.
    viewer: { userId: null, userGroups: [], isAdmin: true },
  });
  if (!preview.ok) return fail(err.badInput(preview.error.message));

  return ok({
    columns: preview.data.columns,
    rows: rowsWithColumnLabels(
      preview.data.columns,
      preview.data.rows.map((row) => ({
        recordId: row.recordId ?? null,
        tableId: row.tableId ?? null,
        ...row.values,
      })),
    ),
  });
};

export const buildTemplateInputContext = (
  record: DocumentTemplateRecordContext,
  table: DocumentTemplateTableContext,
  appData: DocumentTemplateAppData = defaultTemplateAppData(),
  businessData: DocumentTemplateBusinessData = {
    legalName: appData.name,
    senderLine: appData.name,
    address: "",
    department: null,
    contactEmail: appData.contactEmail,
    phone: null,
    url: appData.url || null,
    taxId: null,
    registration: null,
    bankName: null,
    iban: null,
    bic: null,
    paymentTerms: null,
    footerText: null,
  },
  template: Partial<Pick<DocumentTemplate, "id" | "shortId" | "name">> | null = null,
  createdAt: Date = new Date(),
  dateConfig?: DateContext,
  recordMeta: DocumentTemplateRecordMeta = {},
): Record<string, unknown> => ({
  record: recordContextWithMeta(
    {
      id: record.shortId,
      shortId: record.shortId,
      tableId: table.shortId,
      version: record.version,
      data: record.data,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
    recordMeta,
  ),
  table: {
    id: table.shortId,
    shortId: table.shortId,
    name: table.name,
  },
  app: appData,
  business: businessData,
  template: templatePatternContext(template),
  date: datePatternContext(createdAt, dateConfig),
});

export const buildRenderData = (params: {
  record: DocumentTemplateRecordContext | SnapshotRecord;
  table: DocumentTemplateTableContext;
  columns: unknown[];
  rows: unknown[];
  template?: Partial<Pick<DocumentTemplate, "id" | "shortId" | "name">> | null;
  document?: { id?: string | null } | null;
  images?: DocumentTemplateImage[];
  primaryImage?: DocumentTemplateImage | null;
  recordMeta?: DocumentTemplateRecordMeta;
  app?: DocumentTemplateAppData;
  business?: DocumentTemplateBusinessData;
  documentNumber?: string;
  createdAt?: string;
  dateConfig?: DateContext;
  snapshot?: RecordSnapshotDraft;
}): Record<string, unknown> => ({
  record: recordContextWithMeta(params.record, params.recordMeta),
  table: params.table,
  query: {
    columns: params.columns,
    rows: params.rows,
  },
  rows: params.rows,
  columns: params.columns,
  template: templatePatternContext(params.template),
  date: datePatternContext(params.createdAt ? new Date(params.createdAt) : new Date(), params.dateConfig),
  images: params.images ?? [],
  primaryImage: params.primaryImage ?? params.images?.[0] ?? null,
  app: params.app ?? defaultTemplateAppData(),
  business:
    params.business ??
    ({
      legalName: (params.app ?? defaultTemplateAppData()).name,
      senderLine: (params.app ?? defaultTemplateAppData()).name,
      address: "",
      department: null,
      contactEmail: (params.app ?? defaultTemplateAppData()).contactEmail,
      phone: null,
      url: (params.app ?? defaultTemplateAppData()).url || null,
      taxId: null,
      registration: null,
      bankName: null,
      iban: null,
      bic: null,
      paymentTerms: null,
      footerText: null,
    } satisfies DocumentTemplateBusinessData),
  document: {
    id: params.document?.id ?? "draft",
    number: params.documentNumber ?? null,
    createdAt: params.createdAt ?? null,
  },
  snapshot: params.snapshot ?? null,
});

const buildTemplateImages = async (tableId: string, recordId: string, fields: Field[]): Promise<DocumentTemplateImage[]> => {
  const fileFields = fields.filter((field) => field.type === "file" && !field.deletedAt);
  const images: DocumentTemplateImage[] = [];
  for (const field of fileFields) {
    if (images.length >= DOCUMENT_IMAGE_MAX_COUNT) break;
    const listed = await listForRecordField({ tableId, recordId, fieldId: field.id });
    if (!listed.ok) continue;
    for (const file of listed.data) {
      if (images.length >= DOCUMENT_IMAGE_MAX_COUNT) break;
      if (!file.mimeType.startsWith("image/") || file.sizeBytes > DOCUMENT_IMAGE_MAX_BYTES) continue;
      const content = await getFileContent({ tableId, recordId, fieldId: field.id, fileId: file.id });
      if (!content.ok) continue;
      images.push({
        fieldId: field.id,
        fieldName: field.name,
        fileId: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        url: `data:${file.mimeType};base64,${Buffer.from(content.data.bytes).toString("base64")}`,
      });
    }
  }
  return images;
};

export const buildLiveRenderData = async (params: {
  template: Pick<DocumentTemplate, "source"> & Partial<Pick<DocumentTemplate, "id" | "shortId" | "name">>;
  table: Table;
  record: GridRecord;
  app?: DocumentTemplateAppData;
  dateConfig?: DateContext;
  createdAt?: Date;
}): Promise<Result<{ source: string; columns: unknown[]; rows: Array<Record<string, unknown>>; data: Record<string, unknown> }>> => {
  const appData = params.app ?? (await buildTemplateAppData());
  const businessData = await buildTemplateBusinessData(params.table.baseId, appData);
  const recordMeta = await buildRecordScanMeta({
    baseId: params.table.baseId,
    tableId: params.table.id,
    recordId: params.record.id,
  });
  const fields = await listFields(params.table.id);
  const relatedRecordIds = fields.flatMap((field) => {
    if (field.type !== "relation") return [];
    const value = params.record.data[field.id];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : typeof value === "string" ? [value] : [];
  });
  const publicRelatedRecordIds = await projectPublicIds("record", relatedRecordIds);
  const templateRecord = {
    ...params.record,
    data: documentRecordDataWithPublicIds(params.record.data, fields, publicRelatedRecordIds),
  };
  const source = await renderDocumentSource(
    params.template,
    buildTemplateInputContext(
      templateRecord,
      params.table,
      appData,
      businessData,
      params.template,
      params.createdAt,
      params.dateConfig,
      recordMeta,
    ),
  );
  if (!source.ok) return source;

  const executed = await executeDocumentGqlSource({
    baseId: params.table.baseId,
    tableId: params.table.id,
    source: source.data,
    dateConfig: params.dateConfig,
  });
  if (!executed.ok) return executed;
  const images = await buildTemplateImages(params.table.id, params.record.id, fields);

  const data = buildRenderData({
    record: { ...templateRecord, id: templateRecord.shortId },
    table: params.table,
    columns: executed.data.columns,
    rows: executed.data.rows,
    template: params.template,
    images,
    recordMeta,
    app: appData,
    business: businessData,
    createdAt: params.createdAt?.toISOString(),
    dateConfig: params.dateConfig,
  });
  return ok({ source: source.data, columns: executed.data.columns, rows: executed.data.rows, data });
};

const injectPageCss = (html: string, pageCss: string | null): string => {
  if (!pageCss?.trim()) return html;
  const style = `<style>\n${pageCss}\n</style>`;
  return /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${style}\n</head>`)
    : `<!doctype html><html><head>${style}</head><body>${html}</body></html>`;
};

export const renderDocumentHtml = async (
  template: Pick<DocumentTemplate, "renderer">,
  data: Record<string, unknown>,
): Promise<Result<string>> => {
  if (template.renderer.kind !== "html") {
    return fail(err.badInput("Document template uses a Document profile instead of HTML."));
  }
  const html = await renderLiquidText(template.renderer.body, data, RENDER_MAX_BYTES);
  if (!html.ok) return html;
  const pageCss = await renderLiquidText(template.renderer.css ?? "", data, TEMPLATE_PART_MAX_BYTES);
  if (!pageCss.ok) return pageCss;
  return ok(injectPageCss(html.data, pageCss.data));
};

export const renderDocumentSource = async (
  template: Pick<DocumentTemplate, "source">,
  data: Record<string, unknown>,
): Promise<Result<string>> => renderLiquidText(template.source, data, SOURCE_MAX_BYTES);

export const renderDocumentPdfPreview = async (
  template: Pick<DocumentTemplate, "renderer">,
  data: Record<string, unknown>,
  filename?: string,
  config?: GotenbergConfig,
): Promise<TemplatePdfPreviewResult> => {
  if (template.renderer.kind !== "html") {
    return { ok: false, error: { phase: "template", message: "Document template uses a Document profile instead of HTML.", status: 400 } };
  }
  return renderTemplatePdfPreview(
    {
      htmlTemplate: template.renderer.body,
      headerHtmlTemplate: template.renderer.header,
      footerHtmlTemplate: template.renderer.footer,
      pageCssTemplate: template.renderer.css,
      data,
      filters: documentLiquidFilters,
      filename,
    },
    config ? { config } : {},
  );
};

export const renderDocumentProfileInput = async (
  template: Pick<DocumentTemplate, "renderer">,
  data: Record<string, unknown>,
): Promise<Result<Record<string, unknown>>> => {
  if (template.renderer.kind !== "profile") return fail(err.badInput("Document template does not use a Document profile."));
  const rendered = await renderLiquidPlainText(template.renderer.inputTemplate, data, RENDER_MAX_BYTES);
  if (!rendered.ok) return rendered;
  try {
    const parsed: unknown = JSON.parse(rendered.data);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return fail(err.badInput("Document profile input must render a JSON object."));
    }
    return ok(parsed as Record<string, unknown>);
  } catch (error) {
    return fail(err.badInput(`Document profile input rendered invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`));
  }
};

export const buildDocumentRenderData = async (params: {
  template: Pick<DocumentTemplate, "renderer"> & Partial<Pick<DocumentTemplate, "id" | "shortId" | "name">>;
  renderData: Record<string, unknown>;
  documentShortId: string;
  createdAt?: Date;
  dateConfig?: DateContext;
  filename?: string | null;
  tags?: string[];
  documentNumber?: string;
  numberSeries?: { id: string; value: number };
}): Promise<Result<{ documentNumber: string; filename: string; tags: string[]; data: Record<string, unknown> }>> => {
  const createdAt = params.createdAt ?? new Date();
  const documentNumber = params.documentNumber
    ? ok(params.documentNumber)
    : params.template.renderer.kind === "html"
      ? documentNumberFor({
          template: { ...params.template, numberTemplate: params.template.renderer.numberTemplate },
          documentShortId: params.documentShortId,
          createdAt,
          dateConfig: params.dateConfig,
          data: params.renderData,
          series: params.numberSeries,
        })
      : fail(err.badInput("Document profile rendering requires an allocated document number."));
  if (!documentNumber.ok) return fail(documentNumber.error);

  const tags = normalizeDocumentTags(params.tags);
  const renderDataBase = {
    ...params.renderData,
    template: templatePatternContext(params.template),
    date: datePatternContext(createdAt, params.dateConfig),
    series: params.numberSeries ?? { id: "draft", value: 0 },
    document: {
      ...((typeof params.renderData.document === "object" && params.renderData.document !== null
        ? params.renderData.document
        : {}) as Record<string, unknown>),
      id: params.documentShortId,
      number: documentNumber.data,
      createdAt: createdAt.toISOString(),
    },
  };
  const requestedFilename = params.filename?.trim() ?? "";
  const renderedFilename = requestedFilename
    ? ok(requestedFilename)
    : params.template.renderer.kind === "html"
      ? await renderLiquidText(params.template.renderer.filenameTemplate, renderDataBase, FILENAME_TEMPLATE_MAX_BYTES)
      : ok(`${documentNumber.data}.pdf`);
  if (!renderedFilename.ok) return fail(renderedFilename.error);

  const filename = safePdfFilename(renderedFilename.data, `${documentNumber.data}.pdf`);
  const data = {
    ...renderDataBase,
    document: {
      ...(renderDataBase.document as Record<string, unknown>),
      filename,
      tags,
    },
  };
  return ok({ documentNumber: documentNumber.data, filename, tags, data });
};

export const renderDocumentPdf = async (
  document: Pick<Document, "templateSnapshot" | "renderData" | "filename">,
): Promise<Result<RenderHtmlToPdfResult>> => {
  const renderer = DocumentTemplateRendererSchema.safeParse(document.templateSnapshot.renderer);
  if (!renderer.success || renderer.data.kind !== "html") return fail(err.badInput("Document snapshot does not contain an HTML renderer."));
  const rendered = await renderTemplatePdfPreview({
    htmlTemplate: renderer.data.body,
    headerHtmlTemplate: renderer.data.header,
    footerHtmlTemplate: renderer.data.footer,
    pageCssTemplate: renderer.data.css,
    data: document.renderData,
    filters: documentLiquidFilters,
    filename: document.filename.replace(/\.pdf$/i, ".html"),
  });
  if (rendered.ok) return ok(rendered.pdf);
  const message = `${rendered.error.phase}: ${rendered.error.message}`;
  return fail(rendered.error.status === 400 ? err.badInput(message) : err.internal(message));
};
