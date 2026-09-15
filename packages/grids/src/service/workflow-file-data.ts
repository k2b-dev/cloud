import { createHash } from "node:crypto";
import { err, fail, isServiceError, ok, type Result } from "@k2b/stdlib";
import { camt } from "@k2b/stdlib/finance";
import { z } from "zod";
import { WorkflowFilePreviewSchema } from "../workflows/file-preview-contracts";
import { type WorkflowDocumentDataCapture, WorkflowFilePayloadSchema } from "../workflows/query-contracts";
import { canonicalDocumentJson, MAX_DOCUMENT_PROFILE_INPUT_BYTES } from "./document-json";
import { documentServiceText } from "./document-messages";

type FileSource = Pick<
  z.infer<typeof WorkflowFilePayloadSchema>["source"],
  "fileId" | "tableId" | "recordId" | "fieldId" | "filename" | "sha256"
>;

/** Pure boundary: no live reads, missing amounts stay missing, exact bytes are retained. */
export const captureWorkflowCamt = (
  input: { source: FileSource; bytes: Uint8Array; capturedAt: string },
  locale?: string,
): Result<WorkflowDocumentDataCapture> => {
  const t = documentServiceText(locale);
  if (input.bytes.byteLength > MAX_DOCUMENT_PROFILE_INPUT_BYTES) return fail(err.badInput(t.workflowCaptureBudget));
  if (createHash("sha256").update(input.bytes).digest("hex") !== input.source.sha256)
    return fail(err.internal(t.workflowQueryIntegrityFailed));
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    return fail(err.badInput(t.camtUtf8Required));
  }
  if (/^\s*<\?xml[^?]*encoding\s*=\s*['"](?!utf-8['"])[^'"]+['"]/i.test(xml)) return fail(err.badInput(t.camtUtf8Required));
  const parsed = camt.parse(xml, { maxCharacters: MAX_DOCUMENT_PROFILE_INPUT_BYTES });
  if (!parsed.ok)
    return fail(
      err.badInput(
        parsed.error.issues.some((issue) => issue.code === "unsupported_format")
          ? t.camtUnsupported
          : parsed.error.issues.some((issue) => issue.code === "input_limit")
            ? t.workflowCaptureBudget
            : t.camtInvalid,
      ),
    );
  try {
    // Serialization removes absent optional properties at the JSON boundary, not values.
    const reports = z.array(z.record(z.string(), z.json())).parse(JSON.parse(JSON.stringify(parsed.data.reports)));
    const payload = WorkflowFilePayloadSchema.parse({
      version: 5,
      source: {
        kind: "file",
        format: "camt.052.001.08",
        ...input.source,
        messageId: parsed.data.messageId,
        createdAt: parsed.data.createdAt,
        ...(parsed.data.pagination ? { pagination: parsed.data.pagination } : {}),
        bytesBase64: Buffer.from(input.bytes).toString("base64"),
      },
      schemaHash: null,
      context: {},
      tableIds: [input.source.tableId],
      selectionLimit: null,
      columns: [{ key: "report", label: "report", type: "json", sqlType: "jsonb" }],
      rows: reports.map((report) => ({ report })),
      rowCount: reports.length,
      rowOrigins: reports.map(() => ({ recordId: null, tableId: null })),
      capturedAt: input.capturedAt,
      complete: true,
    });
    const canonical = canonicalDocumentJson(payload, locale);
    return ok({ payload, sha256: canonical.sha256, capturedAt: payload.capturedAt, rowCount: payload.rowCount });
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    return fail(err.internal(t.workflowQueryIntegrityFailed));
  }
};

// Project only fields needed for the human overview; the full typed reports
// remain available under details, without flattening transactions into entries.
const ReportSummarySchema = z.object({
  id: z.string(),
  account: z.object({ id: z.object({ value: z.string() }), currency: z.string().optional() }),
  period: z.object({ from: z.string(), to: z.string() }).optional(),
  pagination: z.object({ pageNumber: z.string(), lastPage: z.boolean() }).optional(),
  entries: z.array(z.object({ status: z.object({ value: z.string() }) })),
});

export const workflowFilePreview = (payload: z.infer<typeof WorkflowFilePayloadSchema>) =>
  WorkflowFilePreviewSchema.parse({
    filename: payload.source.filename,
    format: payload.source.format,
    messageId: payload.source.messageId,
    createdAt: payload.source.createdAt,
    capturedAt: payload.capturedAt,
    pagination: payload.source.pagination ?? null,
    reports: payload.rows.map((row) => {
      const report = ReportSummarySchema.parse(row.report);
      const statuses = new Map<string, number>();
      for (const entry of report.entries) statuses.set(entry.status.value, (statuses.get(entry.status.value) ?? 0) + 1);
      return {
        id: report.id,
        account: report.account.id.value,
        currency: report.account.currency ?? null,
        period: report.period ?? null,
        pagination: report.pagination ?? null,
        entryCount: report.entries.length,
        statuses: Object.fromEntries(statuses),
        details: row.report,
      };
    }),
  });
