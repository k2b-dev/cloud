import type { CliInputFlagValue, CloudCliContext } from "@valentinkolb/cloud/cli";
import { flag } from "@valentinkolb/cloud/cli";
import type { z } from "zod";
import type {
  PublicDocumentBrowseResponseSchema,
  PublicDocumentSchema,
  PublicDocumentTemplateSchema,
  PublicDocumentTemplateSummarySchema,
} from "../api/documents-api-shared";
import type { PublicBase as Base, PublicTable as Table } from "../api/public-dto";
import type { DocumentLink, DocumentTemplateRenderer } from "../contracts";
import { resolveBaseFromCommand, resolveNamedResource, resolveTable } from "./resources";
import { applyDefined, queryString, readApi, readJsonInput, readTextInput } from "./runtime";

export const documentTemplateFlag = {
  template: flag.string({ description: "Document template public id or exact name" }),
};

export const DOCUMENT_TEMPLATE_REFERENCE = {
  fields: {
    name: "Template label shown in Grids.",
    source: "GQL source. Use {{ record.id }} in the where clause for per-record templates.",
    renderer:
      "Renderer definition. Use {kind:'html', body, header?, footer?, css?, numberTemplate, filenameTemplate} or {kind:'profile', id, version, inputTemplate}.",
    enabled: "Disabled templates are hidden from normal generation flows.",
  },
  liquidData: [
    "record.id",
    "record.data.<field label or key>",
    "rows",
    "columns",
    "table.name",
    "template.id",
    "template.name",
    "document.number",
    "document.id",
    "document.createdAt",
    "app.name",
    "app.logo",
    "business.legalName",
  ],
  examples: [
    {
      source: 'from table Invoices\nwhere record.id = "{{ record.id }}"\nlimit 1',
      renderer: {
        kind: "html",
        body: "<h1>Invoice {{ document.number }}</h1>\n<p>{{ record.data.Customer }}</p>",
        numberTemplate: "INV-{{ date.yyyy }}-{{ document.id }}",
        filenameTemplate: "invoice-{{ document.number }}.pdf",
      },
    },
    {
      source: 'from table Invoices\nwhere record.id = "{{ record.id }}"\nlimit 1',
      renderer: {
        kind: "profile",
        id: "de.zugferd.en16931",
        version: 1,
        inputTemplate: '{"invoiceDate": {{ record.data.InvoiceDate | json }}, "currency": "EUR"}',
      },
    },
  ],
};

type PublicDocumentTemplate = z.infer<typeof PublicDocumentTemplateSchema>;
type PublicDocumentTemplateSummary = z.infer<typeof PublicDocumentTemplateSummarySchema>;
type PublicDocument = z.infer<typeof PublicDocumentSchema>;
type PublicDocumentBrowseResponse = z.infer<typeof PublicDocumentBrowseResponseSchema>;

export const listDocumentTemplates = (
  ctx: CloudCliContext,
  tableId: string,
  options: { full?: boolean; min?: "read" | "write" | "admin" } = {},
): Promise<Array<PublicDocumentTemplate | PublicDocumentTemplateSummary>> =>
  options.full
    ? readApi<PublicDocumentTemplate[]>(ctx, `/documents/templates/by-table/${encodeURIComponent(tableId)}/full`)
    : readApi<PublicDocumentTemplateSummary[]>(
        ctx,
        `/documents/templates/by-table/${encodeURIComponent(tableId)}${queryString({ min: options.min ?? "read" })}`,
      );

export const resolveDocumentTemplate = async (ctx: CloudCliContext, table: Table | null, ref: string): Promise<PublicDocumentTemplate> => {
  if (!table) throw new Error("Resolving a document template requires --table because names and ids are table-scoped.");
  const summary = resolveNamedResource(await listDocumentTemplates(ctx, table.id, { full: true }), ref, "document template");
  return summary as PublicDocumentTemplate;
};

export const documentTemplateRows = (items: Array<PublicDocumentTemplate | PublicDocumentTemplateSummary>) =>
  items.map((template) => ({
    id: template.id,
    name: template.name,
    enabled: template.enabled ? "yes" : "no",
    updatedAt: template.updatedAt,
  }));

export const documentRows = (items: PublicDocument[]) =>
  items.map((document) => ({
    id: document.id,
    number: document.number,
    filename: document.filename,
    tags: document.tags.join(", "),
    createdAt: document.createdAt,
  }));

export const documentFolderRows = (items: PublicDocumentBrowseResponse["folders"]) =>
  items.map((folder) => ({
    kind: folder.kind,
    label: folder.label,
    count: folder.count,
    path: folder.path.join("/"),
  }));

export const documentLinkRows = (items: DocumentLink[]) =>
  items.map((link) => ({
    id: link.id,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt ?? "-",
    accessCount: link.accessCount,
    comment: link.comment ?? "",
  }));

export const readDraftTemplateBody = async (
  flags: {
    body: CliInputFlagValue;
    record?: string;
    source: CliInputFlagValue;
    html: CliInputFlagValue;
    headerHtml: CliInputFlagValue;
    footerHtml: CliInputFlagValue;
    pageCss: CliInputFlagValue;
    numberTemplate?: string;
    filenameTemplate?: string;
  },
  template: PublicDocumentTemplate | null,
) => {
  const body = (await readJsonInput<Record<string, unknown>>(flags.body, "document template draft JSON", false)) ?? {};
  const source = await readTextInput(flags.source, "draft GQL source", false);
  const html = await readTextInput(flags.html, "draft HTML", false);
  const headerHtml = await readTextInput(flags.headerHtml, "draft header HTML", false);
  const footerHtml = await readTextInput(flags.footerHtml, "draft footer HTML", false);
  const pageCss = await readTextInput(flags.pageCss, "draft page CSS", false);
  applyDefined(body, { source, recordId: flags.record });
  applyHtmlRendererFlags(body, { html, headerHtml, footerHtml, pageCss, numberTemplate: flags.numberTemplate, filenameTemplate: flags.filenameTemplate }, template);
  if (template) {
    applyDefined(body, {
      source: body.source ?? template.source,
      renderer: body.renderer ?? template.renderer,
    });
  }
  if (!body.recordId) throw new Error("Missing record id. Pass --record or --body JSON.");
  if (!body.source) throw new Error("Missing draft GQL source. Pass --source, --source-file, --body JSON, or a template argument.");
  if (!body.renderer) throw new Error("Missing draft renderer. Pass --html, renderer in --body JSON, or a template argument.");
  return body;
};

export const applyHtmlRendererFlags = (
  body: Record<string, unknown>,
  flags: {
    html?: string;
    headerHtml?: string;
    footerHtml?: string;
    pageCss?: string;
    numberTemplate?: string;
    filenameTemplate?: string;
  },
  template: PublicDocumentTemplate | null = null,
) => {
  const hasOverride = Object.values(flags).some((value) => value !== undefined);
  if (!hasOverride) return;
  const current = body.renderer as DocumentTemplateRenderer | undefined;
  const base = current?.kind === "html" ? current : template?.renderer.kind === "html" ? template.renderer : null;
  body.renderer = {
    kind: "html",
    body: flags.html ?? base?.body ?? "",
    header: flags.headerHtml ?? base?.header,
    footer: flags.footerHtml ?? base?.footer,
    css: flags.pageCss ?? base?.css,
    numberTemplate: flags.numberTemplate ?? base?.numberTemplate ?? "",
    filenameTemplate: flags.filenameTemplate ?? base?.filenameTemplate ?? "",
  } satisfies DocumentTemplateRenderer;
};

export const resolveDocumentTemplateFromCommand = async (
  ctx: CloudCliContext,
  args: string[],
  refs: { table?: string; template?: string },
): Promise<{ base: Base; table: Table | null; template: PublicDocumentTemplate }> => {
  const { base, rest } = await resolveBaseFromCommand(ctx, args, refs.table || refs.template ? 0 : 2);
  const table = refs.table
    ? await resolveTable(ctx, base.id, refs.table)
    : rest.length >= 2
      ? await resolveTable(ctx, base.id, rest[0]!)
      : null;
  const templateRef = refs.template ?? (table ? rest[1] : rest[0]);
  if (!templateRef) throw new Error("Missing document template.");
  return { base, table, template: await resolveDocumentTemplate(ctx, table, templateRef) };
};
