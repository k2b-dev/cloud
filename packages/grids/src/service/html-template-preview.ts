import type { DateContext } from "@k2b/stdlib";
import { ok, type Result } from "@k2b/stdlib";
import { HTML_TEMPLATE_ERROR, htmlTemplateConfigSchema } from "../field-types/html-template";
import { documentServiceText } from "./document-messages";
import { enrichRecordsWithHtmlTemplates } from "./html-template-fields";
import type { AuthorizedRecordAccess } from "./record-access";
import { list as listRecords } from "./records";
import type { ExpansionViewer } from "./relations";

type HtmlTemplatePreviewResult = {
  ok: boolean;
  diagnostics: Array<{
    code: "html.invalid_config" | "html.empty" | "html.field_not_found" | "html.render_failed";
    severity: "error" | "info";
    message: string;
  }>;
  rows: Array<{ recordId: string; html: string }>;
};

export const checkHtmlTemplate = async (params: {
  tableId: string;
  fieldId: string;
  template: string;
  css: string;
  dateConfig?: DateContext;
  recordAccess?: AuthorizedRecordAccess;
  viewer?: ExpansionViewer;
}): Promise<Result<HtmlTemplatePreviewResult>> => {
  const t = documentServiceText(params.dateConfig?.locale);
  const config = htmlTemplateConfigSchema.safeParse({ template: params.template, css: params.css });
  if (!config.success) {
    return ok({
      ok: false,
      diagnostics: config.error.issues.map((issue) => ({
        code: "html.invalid_config" as const,
        severity: "error" as const,
        message: t.invalidHtmlConfig({ field: issue.path.join(".") || "template" }),
      })),
      rows: [],
    });
  }
  if (!config.data.template) {
    return ok({
      ok: true,
      diagnostics: [{ code: "html.empty", severity: "info", message: t.previewTemplateHint }],
      rows: [],
    });
  }

  const listed = await listRecords({
    tableId: params.tableId,
    limit: 5,
    sort: [{ source: "record", key: "createdAt", direction: "desc" }],
    viewer: params.viewer,
    dateConfig: params.dateConfig,
    recordAccess: params.recordAccess,
    htmlTemplateFieldIds: [],
  });
  if (!listed.ok) return listed;
  const current = listed.data.fields.find((field) => field.id === params.fieldId && field.type === "html_template" && !field.deletedAt);
  if (!current) {
    return ok({
      ok: false,
      diagnostics: [{ code: "html.field_not_found", severity: "error", message: t.htmlFieldNotFound }],
      rows: [],
    });
  }
  const fields = listed.data.fields.map((field) => (field.id === current.id ? { ...field, config: config.data } : field));
  await enrichRecordsWithHtmlTemplates(listed.data.items, fields, { dateConfig: params.dateConfig, fieldIds: new Set([current.id]) });
  const rows = listed.data.items.map((record) => ({ recordId: record.shortId, html: String(record.data[current.id] ?? "") }));
  const failed = rows.some((row) => row.html === HTML_TEMPLATE_ERROR);
  return ok({
    ok: !failed,
    diagnostics: failed ? [{ code: "html.render_failed", severity: "error", message: t.previewRenderFailed }] : [],
    rows,
  });
};
