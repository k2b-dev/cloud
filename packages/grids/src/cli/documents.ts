import { arg, command, confirmFlag, flag } from "@k2b/cloud/cli";
import type { z } from "zod";
import { DOCUMENT_CATALOG_SORTS, PUBLIC_DOCUMENT_PAGE_LIMIT } from "../api/document-public-contracts";
import type {
  PublicDocumentBrowseResponseSchema,
  PublicDocumentListSchema,
  PublicDocumentSchema,
  PublicDocumentTemplateSchema,
} from "../api/documents-api-shared";
import type { CreateDocumentLinkResponse, DocumentLink, DocumentLinkListResponse, DocumentPreviewResponse } from "../contracts";
import {
  applyHtmlRendererFlags,
  DOCUMENT_TEMPLATE_REFERENCE,
  documentFolderRows,
  documentLinkRows,
  documentRows,
  documentTemplateFlag,
  documentTemplateRows,
  listDocumentTemplates,
  readDraftTemplateBody,
  resolveDocumentTemplateFromCommand,
  resolveFullDocumentTemplate,
  resolveFullDocumentTemplateFromCommand,
} from "./documents-support";
import {
  baseArgs,
  baseFlag,
  recordArgs,
  requirePublicId,
  resolveBaseFromCommand,
  resolveRecordFromCommand,
  resolveTable,
  resolveTableFromCommand,
  tableArgs,
  tableFlag,
} from "./resources";
import {
  applyDefined,
  JSON_BODY_INPUT,
  jsonRequest,
  type MessageResponse,
  printCliStructured,
  printJsonOrMessage,
  printJsonOrTable,
  printReference,
  queryString,
  readApi,
  readJsonInput,
  writeApiFile,
} from "./runtime";

type PublicDocument = z.infer<typeof PublicDocumentSchema>;
type PublicDocumentList = z.infer<typeof PublicDocumentListSchema>;
type PublicDocumentBrowseResponse = z.infer<typeof PublicDocumentBrowseResponseSchema>;
type PublicDocumentTemplate = z.infer<typeof PublicDocumentTemplateSchema>;

export const documentTemplateCommands = [
  command("document-templates reference", {
    summary: "Show document template fields, Liquid data, and examples",
    description: "Use this before creating or updating document templates from an agent.",
    examples: ["cld grids document-templates reference", "cld grids document-templates reference --json"],
    async run({ ctx }) {
      printReference(
        ctx,
        DOCUMENT_TEMPLATE_REFERENCE,
        [
          "Document templates",
          "",
          "Create PDFs from a GQL source plus Liquid HTML/CSS. Per-record templates usually filter with:",
          "  where record.id = '{{ record.id }}'",
          "",
          "Fields:",
          ...Object.entries(DOCUMENT_TEMPLATE_REFERENCE.fields).map(([key, value]) => `  ${key}: ${value}`),
          "Read --json for createSchema/updateSchema; documents renderers --json includes each profile inputSchema.",
          "",
          "Liquid data:",
          ...DOCUMENT_TEMPLATE_REFERENCE.liquidData.map((item) => `  ${item}`),
          "",
          "Example source:",
          `  ${DOCUMENT_TEMPLATE_REFERENCE.examples[0]!.source.replace(/\n/g, "\n  ")}`,
        ].join("\n"),
      );
    },
  }),
  command("document-templates list", {
    summary: "List document templates for a table",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      min: flag.enum(["read", "write", "admin"] as const, { default: "read", description: "Minimum effective permission" }),
      full: flag.boolean({ description: "Return full templates; requires table admin access" }),
    },
    async run({ ctx, args, flags }) {
      const { table } = await resolveTableFromCommand(ctx, args.args);
      const templates = await listDocumentTemplates(ctx, table.id, { full: flags.full, min: flags.min });
      printJsonOrTable(ctx, templates, documentTemplateRows(templates), [
        { key: "id", label: "ID" },
        { key: "name", label: "NAME" },
        { key: "enabled", label: "ENABLED" },
        { key: "updatedAt", label: "UPDATED" },
      ]);
    },
  }),
  command("document-templates get", {
    summary: "Show a document template",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, ...documentTemplateFlag },
    async run({ ctx, args, flags }) {
      const { template } = await resolveFullDocumentTemplateFromCommand(ctx, args.args, flags);
      if (!printCliStructured(ctx, template)) {
        ctx.print(`${template.name} (${template.id})`);
        if (template.description) ctx.print(template.description);
        ctx.print(`enabled: ${template.enabled ? "yes" : "no"}`);
        ctx.print(`id: ${template.id}`);
        ctx.print("");
        ctx.print(template.source);
      }
    },
  }),
  command("document-templates create", {
    summary: "Create a document template",
    description: "Run `cld grids document-templates reference` for Liquid variables, GQL source shape, and filename/number patterns.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Template name" }),
      description: flag.string({ description: "Template description" }),
      source: flag.string({ description: "GQL source" }),
      html: flag.string({ description: "Liquid HTML body" }),
      headerHtml: flag.string({ name: "header-html", description: "Liquid header HTML" }),
      footerHtml: flag.string({ name: "footer-html", description: "Liquid footer HTML" }),
      pageCss: flag.string({ name: "page-css", description: "Page CSS" }),
      numberTemplate: flag.string({ name: "number-template", description: "Liquid document number pattern" }),
      filenameTemplate: flag.string({ name: "filename-template", description: "Liquid filename pattern" }),
      enabled: flag.boolean({ description: "Enable the template" }),
      disabled: flag.boolean({ description: "Create the template disabled" }),
    },
    examples: [
      "cld grids document-templates create Bookshop Invoices --name Invoice --source 'from table Invoices' --html '<h1>{{ document.number }}</h1>' --number-template '{{ document.id }}' --filename-template '{{ document.number }}.pdf' --disabled",
      "cld grids document-templates create --base Bookshop --table Labels --body-file label-template.json",
    ],
    async run({ ctx, args, flags }) {
      const { table } = await resolveTableFromCommand(ctx, args.args);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "document template JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
        source: flags.source,
        enabled: flags.enabled ? true : flags.disabled ? false : undefined,
      });
      applyHtmlRendererFlags(body, flags);
      if (!body.name) throw new Error("Missing document template name. Pass --name or --body JSON.");
      if (!body.source) throw new Error("Missing document template source. Pass --source or --body JSON.");
      if (!body.renderer) throw new Error("Missing document template renderer. Pass --html flags or renderer in --body JSON.");
      const template = await readApi<PublicDocumentTemplate>(
        ctx,
        `/documents/templates/by-table/${encodeURIComponent(table.id)}`,
        jsonRequest("POST", body),
      );
      printJsonOrMessage(ctx, template, `Created document template ${template.name} (${template.id}).`);
    },
  }),
  command("document-templates update", {
    summary: "Update a document template",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...documentTemplateFlag,
      body: JSON_BODY_INPUT,
      name: flag.string({ description: "Template name" }),
      description: flag.string({ description: "Template description" }),
      source: flag.string({ description: "GQL source" }),
      html: flag.string({ description: "Liquid HTML body" }),
      headerHtml: flag.string({ name: "header-html", description: "Liquid header HTML" }),
      footerHtml: flag.string({ name: "footer-html", description: "Liquid footer HTML" }),
      pageCss: flag.string({ name: "page-css", description: "Page CSS" }),
      numberTemplate: flag.string({ name: "number-template", description: "Liquid document number pattern" }),
      filenameTemplate: flag.string({ name: "filename-template", description: "Liquid filename pattern" }),
      enabled: flag.boolean({ description: "Enable the template" }),
      disabled: flag.boolean({ description: "Disable the template" }),
      position: flag.int({ min: 0, description: "Template position" }),
    },
    async run({ ctx, args, flags }) {
      const { template } = await resolveFullDocumentTemplateFromCommand(ctx, args.args, flags);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "document template update JSON", false)) ?? {};
      applyDefined(body, {
        name: flags.name,
        description: flags.description,
        source: flags.source,
        enabled: flags.enabled ? true : flags.disabled ? false : undefined,
        position: flags.position,
      });
      applyHtmlRendererFlags(body, flags, template);
      const updated = await readApi<PublicDocumentTemplate>(
        ctx,
        `/documents/templates/${encodeURIComponent(template.id)}`,
        jsonRequest("PATCH", body),
      );
      printJsonOrMessage(ctx, updated, `Updated document template ${updated.name} (${updated.id}).`);
    },
  }),
  command("document-templates delete", {
    summary: "Delete a document template",
    args: tableArgs,
    flags: { ...baseFlag, ...tableFlag, ...documentTemplateFlag, yes: confirmFlag("Delete this document template") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete.");
      const { template } = await resolveFullDocumentTemplateFromCommand(ctx, args.args, flags);
      await readApi<MessageResponse>(ctx, `/documents/templates/${encodeURIComponent(template.id)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { deleted: template.id }, `Deleted document template ${template.name} (${template.id}).`);
    },
  }),
  command("document-templates preview-data", {
    summary: "Render document template preview data for one record",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...documentTemplateFlag,
      body: JSON_BODY_INPUT,
      record: flag.string({ description: "Record public id" }),
    },
    async run({ ctx, args, flags }) {
      const { template } = await resolveFullDocumentTemplateFromCommand(ctx, args.args, flags);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "document preview JSON", false)) ?? {};
      applyDefined(body, { recordId: flags.record ? requirePublicId(flags.record, "Record id") : undefined });
      if (!body.recordId) throw new Error("Missing record id. Pass --record or --body JSON.");
      const preview = await readApi<DocumentPreviewResponse>(
        ctx,
        `/documents/templates/${encodeURIComponent(template.id)}/preview`,
        jsonRequest("POST", body),
      );
      if (!printCliStructured(ctx, preview)) ctx.print(preview.html);
    },
  }),
  command("document-templates preview-pdf", {
    summary: "Render document template PDF preview for one record",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...documentTemplateFlag,
      body: JSON_BODY_INPUT,
      record: flag.string({ description: "Record public id" }),
      out: flag.string({ description: "Output PDF path" }),
    },
    async run({ ctx, args, flags }) {
      const { template } = await resolveDocumentTemplateFromCommand(ctx, args.args, flags);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "document preview JSON", false)) ?? {};
      applyDefined(body, { recordId: flags.record ? requirePublicId(flags.record, "Record id") : undefined });
      if (!body.recordId) throw new Error("Missing record id. Pass --record or --body JSON.");
      await writeApiFile(ctx, `/documents/templates/${encodeURIComponent(template.id)}/preview-pdf`, jsonRequest("POST", body), flags.out);
    },
  }),
  command("document-templates preview-draft-data", {
    summary: "Render unsaved document template draft data for one record",
    description:
      "Pass a table and draft body, or also pass a saved template to use its source/html/header/footer/page CSS defaults before applying overrides.",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...documentTemplateFlag,
      body: JSON_BODY_INPUT,
      record: flag.string({ description: "Preview record public id" }),
      source: flag.input({ name: "source", fileName: "source-file", valueLabel: "gql" }),
      html: flag.input({ name: "html", fileName: "html-file", valueLabel: "html" }),
      headerHtml: flag.input({ name: "header-html", fileName: "header-html-file", valueLabel: "html" }),
      footerHtml: flag.input({ name: "footer-html", fileName: "footer-html-file", valueLabel: "html" }),
      pageCss: flag.input({ name: "page-css", fileName: "page-css-file", valueLabel: "css" }),
      numberTemplate: flag.string({ name: "number-template", description: "Liquid document number pattern" }),
      filenameTemplate: flag.string({ name: "filename-template", description: "Liquid filename pattern" }),
    },
    async run({ ctx, args, flags }) {
      const { table, rest } = await resolveTableFromCommand(ctx, args.args);
      const templateRef = flags.template ?? rest[0];
      const template = templateRef ? await resolveFullDocumentTemplate(ctx, table, templateRef) : null;
      const body = await readDraftTemplateBody(flags, template);
      const endpoint = template
        ? `/documents/templates/${encodeURIComponent(template.id)}/preview-data-draft`
        : `/documents/templates/by-table/${encodeURIComponent(table.id)}/preview-data-draft`;
      const preview = await readApi<DocumentPreviewResponse>(ctx, endpoint, jsonRequest("POST", body));
      if (!printCliStructured(ctx, preview)) ctx.print(preview.html);
    },
  }),
  command("document-templates preview-draft-pdf", {
    summary: "Render an unsaved document template draft PDF for one record",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...documentTemplateFlag,
      body: JSON_BODY_INPUT,
      record: flag.string({ description: "Preview record public id" }),
      source: flag.input({ name: "source", fileName: "source-file", valueLabel: "gql" }),
      html: flag.input({ name: "html", fileName: "html-file", valueLabel: "html" }),
      headerHtml: flag.input({ name: "header-html", fileName: "header-html-file", valueLabel: "html" }),
      footerHtml: flag.input({ name: "footer-html", fileName: "footer-html-file", valueLabel: "html" }),
      pageCss: flag.input({ name: "page-css", fileName: "page-css-file", valueLabel: "css" }),
      numberTemplate: flag.string({ name: "number-template", description: "Liquid document number pattern" }),
      filenameTemplate: flag.string({ name: "filename-template", description: "Liquid filename pattern" }),
      out: flag.string({ description: "Output PDF path" }),
    },
    async run({ ctx, args, flags }) {
      const { table, rest } = await resolveTableFromCommand(ctx, args.args);
      const templateRef = flags.template ?? rest[0];
      const template = templateRef ? await resolveFullDocumentTemplate(ctx, table, templateRef) : null;
      const body = await readDraftTemplateBody(flags, template);
      const endpoint = template
        ? `/documents/templates/${encodeURIComponent(template.id)}/preview-draft`
        : `/documents/templates/by-table/${encodeURIComponent(table.id)}/preview-draft`;
      await writeApiFile(ctx, endpoint, jsonRequest("POST", body), flags.out);
    },
  }),
];

export const documentCommands = [
  command("documents renderers", {
    summary: "List installed Document renderers",
    async run({ ctx }) {
      const renderers = await readApi<Array<{ id: string; version: number; title: string; description: string }>>(
        ctx,
        "/documents/renderers",
      );
      printJsonOrTable(ctx, renderers, renderers, [
        { key: "id", label: "ID" },
        { key: "version", label: "VERSION" },
        { key: "title", label: "TITLE" },
        { key: "description", label: "DESCRIPTION" },
      ]);
    },
  }),
  command("documents list", {
    summary: "List, search, filter and sort all Documents of a Base",
    description:
      "Filters combine. --workflow matches every Document of its runs; --table matches only Documents bound directly to one of its records, not source records or ZIP contents. Keep --sort when passing a cursor.",
    examples: [
      "cld grids documents list --base BASE_ID --workflow WORKFLOW_ID --media-type application/zip --json",
      "cld grids documents list --base BASE_ID --table Invoices --sort oldest",
    ],
    args: baseArgs,
    flags: {
      ...baseFlag,
      q: flag.string({ aliases: ["query"], description: "Search filename, document number, or tags" }),
      workflow: flag.string({ description: "Workflow public id" }),
      template: flag.string({ description: "Document template public id" }),
      table: flag.string({ description: "Table name or public id of the directly bound record" }),
      mediaType: flag.string({ name: "media-type", description: "Primary file media type, for example application/pdf" }),
      sort: flag.enum(DOCUMENT_CATALOG_SORTS, { default: "newest", description: "Sort order" }),
      cursor: flag.string({ description: "Pagination cursor" }),
      limit: flag.int({ min: 1, max: PUBLIC_DOCUMENT_PAGE_LIMIT, description: "Maximum Documents" }),
    },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const table = flags.table ? await resolveTable(ctx, base.id, flags.table) : null;
      const payload = await readApi<PublicDocumentList>(
        ctx,
        `/documents/by-base/${encodeURIComponent(base.id)}${queryString({
          q: flags.q,
          workflow: flags.workflow ? requirePublicId(flags.workflow, "Workflow id") : undefined,
          template: flags.template ? requirePublicId(flags.template, "Document template id") : undefined,
          table: table?.id,
          mediaType: flags.mediaType,
          sort: flags.sort,
          cursor: flags.cursor,
          limit: flags.limit,
        })}`,
      );
      printJsonOrTable(ctx, payload, documentRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "number", label: "NUMBER" },
        { key: "filename", label: "FILENAME" },
        { key: "tags", label: "TAGS" },
        { key: "createdAt", label: "CREATED" },
      ]);
      if (ctx.options.output !== "json" && payload.cursor) ctx.print(`next cursor: ${payload.cursor}`);
    },
  }),
  command("documents get", {
    summary: "Show a Document and its artifacts",
    args: { document: arg.required({ description: "Document public id" }) },
    async run({ ctx, args }) {
      const document = await readApi<PublicDocument>(
        ctx,
        `/documents/${encodeURIComponent(requirePublicId(args.document, "Document id"))}`,
      );
      printJsonOrMessage(ctx, document, `${document.number} (${document.id})`);
    },
  }),
  command("documents download-artifact", {
    summary: "Download one stored Document artifact",
    args: {
      document: arg.required({ description: "Document public id" }),
      artifact: arg.required({ description: "Artifact key from documents get" }),
    },
    flags: { out: flag.string({ description: "Output path" }) },
    async run({ ctx, args, flags }) {
      await writeApiFile(
        ctx,
        `/documents/${encodeURIComponent(requirePublicId(args.document, "Document id"))}/artifacts/${encodeURIComponent(args.artifact)}`,
        undefined,
        flags.out,
      );
    },
  }),
  command("documents list-by-template", {
    summary: "List generated documents for a document template",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...documentTemplateFlag,
      q: flag.string({ aliases: ["query"], description: "Search generated document filename, number, or tags" }),
      tag: flag.stringList({ description: "Tag filter. Repeatable." }),
      cursor: flag.string({ description: "Pagination cursor" }),
      limit: flag.int({ min: 1, max: PUBLIC_DOCUMENT_PAGE_LIMIT, description: "Maximum documents" }),
    },
    async run({ ctx, args, flags }) {
      const { template } = await resolveDocumentTemplateFromCommand(ctx, args.args, flags);
      const payload = await readApi<PublicDocumentList>(
        ctx,
        `/documents/by-template/${encodeURIComponent(template.id)}${queryString({
          q: flags.q,
          tags: flags.tag.join(","),
          cursor: flags.cursor,
          limit: flags.limit,
        })}`,
      );
      printJsonOrTable(ctx, payload, documentRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "number", label: "NUMBER" },
        { key: "filename", label: "FILENAME" },
        { key: "tags", label: "TAGS" },
        { key: "createdAt", label: "CREATED" },
      ]);
      if (ctx.options.output !== "json" && payload.cursor) ctx.print(`next cursor: ${payload.cursor}`);
    },
  }),
  command("documents browse", {
    summary: "Browse generated documents as list rows or year/month folders",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...documentTemplateFlag,
      mode: flag.enum(["list", "folders"] as const, { default: "folders", description: "Browse mode" }),
      path: flag.string({ description: "Folder path such as 2026/07" }),
      q: flag.string({ aliases: ["query"], description: "Search generated document filename, number, or tags" }),
      tag: flag.stringList({ description: "Tag filter. Repeatable." }),
      cursor: flag.string({ description: "Pagination cursor" }),
      limit: flag.int({ min: 1, max: PUBLIC_DOCUMENT_PAGE_LIMIT, description: "Maximum documents or folders" }),
    },
    async run({ ctx, args, flags }) {
      const { template } = await resolveDocumentTemplateFromCommand(ctx, args.args, flags);
      const payload = await readApi<PublicDocumentBrowseResponse>(
        ctx,
        `/documents/by-template/${encodeURIComponent(template.id)}/browse${queryString({
          mode: flags.mode,
          path: flags.path,
          q: flags.q,
          tags: flags.tag.join(","),
          cursor: flags.cursor,
          limit: flags.limit,
        })}`,
      );
      if (printCliStructured(ctx, payload)) return;
      if (payload.folders.length > 0) {
        ctx.table(documentFolderRows(payload.folders), [
          { key: "kind", label: "KIND" },
          { key: "label", label: "FOLDER" },
          { key: "count", label: "COUNT" },
          { key: "path", label: "PATH" },
        ]);
      }
      if (payload.items.length > 0) {
        ctx.table(documentRows(payload.items), [
          { key: "id", label: "ID" },
          { key: "number", label: "NUMBER" },
          { key: "filename", label: "FILENAME" },
          { key: "tags", label: "TAGS" },
          { key: "createdAt", label: "CREATED" },
        ]);
      }
      if (payload.folders.length === 0 && payload.items.length === 0) ctx.print("No documents.");
      if (payload.cursor) ctx.print(`next cursor: ${payload.cursor}`);
    },
  }),
  command("documents sources", {
    summary: "List the frozen record associations of a Document",
    args: { document: arg.required({ description: "Document public id" }) },
    flags: { offset: flag.string({ description: "Page offset" }), limit: flag.string({ description: "Page size, maximum 100" }) },
    async run({ ctx, args, flags }) {
      const params = new URLSearchParams();
      for (const [key, value, minimum, maximum] of [
        ["offset", flags.offset, 0, Number.MAX_SAFE_INTEGER],
        ["limit", flags.limit, 1, 100],
      ] as const) {
        if (value === undefined) continue;
        const number = Number(value);
        if (!value.trim() || !Number.isSafeInteger(number) || number < minimum || number > maximum)
          throw new Error(`--${key} must be an integer between ${minimum} and ${maximum}`);
        params.set(key, String(number));
      }
      const payload = await readApi<{
        items: Array<{ tableId: string; recordId: string; tableName: string; label: string; version: number | null; deleted: boolean }>;
        hasMore: boolean;
      }>(ctx, `/documents/${encodeURIComponent(requirePublicId(args.document, "Document id"))}/sources${params.size ? `?${params}` : ""}`);
      printJsonOrTable(ctx, payload, payload.items, [
        { key: "tableName", label: "TABLE" },
        { key: "label", label: "RECORD" },
        { key: "recordId", label: "ID" },
        { key: "version", label: "CAPTURED VERSION" },
        { key: "deleted", label: "DELETED" },
      ]);
    },
  }),
  command("documents contents", {
    summary: "List the files packaged in a ZIP Document",
    description: "Frozen provenance: each packaged path, its size, and the Document artifact it came from.",
    args: { document: arg.required({ description: "Document public id" }) },
    flags: {
      offset: flag.int({ min: 0, description: "Page offset" }),
      limit: flag.int({ min: 1, max: 100, description: "Page size, maximum 100" }),
    },
    async run({ ctx, args, flags }) {
      const payload = await readApi<{
        items: Array<{ path: string; sizeBytes: number; documentId: string; artifactKey: string; downloadUrl: string }>;
        total: number;
        hasMore: boolean;
      }>(
        ctx,
        `/documents/${encodeURIComponent(requirePublicId(args.document, "Document id"))}/contents${queryString({
          offset: flags.offset,
          limit: flags.limit,
        })}`,
      );
      printJsonOrTable(ctx, payload, payload.items, [
        { key: "path", label: "PATH" },
        { key: "sizeBytes", label: "BYTES" },
        { key: "documentId", label: "DOCUMENT" },
        { key: "artifactKey", label: "ARTIFACT" },
      ]);
    },
  }),
  command("documents by-record", {
    summary: "List generated documents for one record",
    args: recordArgs,
    flags: { ...baseFlag, ...tableFlag, record: flag.string({ description: "Record public id" }) },
    async run({ ctx, args, flags }) {
      const { table, recordId } = await resolveRecordFromCommand(ctx, args.args);
      const payload = await readApi<PublicDocumentList>(
        ctx,
        `/documents/by-record/${encodeURIComponent(table.id)}/${encodeURIComponent(recordId)}`,
      );
      printJsonOrTable(ctx, payload, documentRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "number", label: "NUMBER" },
        { key: "filename", label: "FILENAME" },
        { key: "tags", label: "TAGS" },
        { key: "createdAt", label: "CREATED" },
      ]);
    },
  }),
  command("documents generate", {
    summary: "Generate and store an immutable Document",
    args: tableArgs,
    flags: {
      ...baseFlag,
      ...tableFlag,
      ...documentTemplateFlag,
      body: JSON_BODY_INPUT,
      record: flag.string({ description: "Record public id" }),
      filename: flag.string({ description: "Optional generated filename override" }),
      idempotencyKey: flag.string({ name: "idempotency-key", description: "Required stable retry key" }),
      tag: flag.stringList({ description: "Generated document tag. Repeatable." }),
      out: flag.string({ description: "Output file path" }),
    },
    examples: [
      "cld grids documents generate Bookshop Invoices Invoice --record <record-id> --idempotency-key invoice-2026-001 --out invoice.pdf",
      'cld grids documents generate --base Bookshop --table Labels --template ItemLabel --body \'{"recordId":"...","tags":["printed"]}\' --out label.pdf',
    ],
    async run({ ctx, args, flags }) {
      const { template } = await resolveDocumentTemplateFromCommand(ctx, args.args, flags);
      const body = (await readJsonInput<Record<string, unknown>>(flags.body, "document generation JSON", false)) ?? {};
      applyDefined(body, {
        recordId: flags.record ? requirePublicId(flags.record, "Record id") : undefined,
        filename: flags.filename,
        tags: flags.tag.length > 0 ? flags.tag : undefined,
        idempotencyKey: flags.idempotencyKey,
      });
      if (!body.recordId) throw new Error("Missing record id. Pass --record or --body JSON.");
      if (!body.idempotencyKey) throw new Error("Missing stable retry key. Pass --idempotency-key or idempotencyKey in --body JSON.");
      if (template.renderer.kind === "profile" && body.filename)
        throw new Error("The selected renderer owns artifact filenames; omit --filename.");
      await writeApiFile(ctx, `/documents/templates/${encodeURIComponent(template.id)}/generate`, jsonRequest("POST", body), flags.out);
    },
  }),
  command("documents download", {
    summary: "Download a generated document's stored primary file",
    args: { document: arg.required({ description: "Document public id" }) },
    flags: { out: flag.string({ description: "Output file path" }) },
    async run({ ctx, args, flags }) {
      await writeApiFile(
        ctx,
        `/documents/${encodeURIComponent(requirePublicId(args.document, "Document id"))}/download`,
        undefined,
        flags.out,
      );
    },
  }),
  command("documents links list", {
    summary: "List public links for a generated document",
    args: { document: arg.required({ description: "Document public id" }) },
    async run({ ctx, args }) {
      const payload = await readApi<DocumentLinkListResponse>(
        ctx,
        `/documents/${encodeURIComponent(requirePublicId(args.document, "Document id"))}/links`,
      );
      printJsonOrTable(ctx, payload, documentLinkRows(payload.items), [
        { key: "id", label: "ID" },
        { key: "expiresAt", label: "EXPIRES" },
        { key: "revokedAt", label: "REVOKED" },
        { key: "accessCount", label: "HITS" },
        { key: "comment", label: "COMMENT" },
      ]);
    },
  }),
  command("documents links create", {
    summary: "Create an expiring public link for a generated document",
    args: { document: arg.required({ description: "Document public id" }) },
    flags: {
      expiresIn: flag.enum(["1d", "7d", "30d", "90d"] as const, {
        name: "expires-in",
        default: "30d",
        description: "Public link lifetime",
      }),
      comment: flag.string({ description: "Optional link comment" }),
    },
    async run({ ctx, args, flags }) {
      const payload = await readApi<CreateDocumentLinkResponse>(
        ctx,
        `/documents/${encodeURIComponent(requirePublicId(args.document, "Document id"))}/links`,
        jsonRequest("POST", { expiresIn: flags.expiresIn, comment: flags.comment }),
      );
      if (!printCliStructured(ctx, payload)) ctx.print(payload.url);
    },
  }),
  command("documents links revoke", {
    summary: "Revoke a public document link",
    args: { link: arg.required({ description: "Document link public id" }) },
    async run({ ctx, args }) {
      const link = await readApi<DocumentLink>(
        ctx,
        `/documents/links/${encodeURIComponent(requirePublicId(args.link, "Document link id"))}/revoke`,
        jsonRequest("POST"),
      );
      printJsonOrMessage(ctx, link, `Revoked document link ${link.id}.`);
    },
  }),
];
