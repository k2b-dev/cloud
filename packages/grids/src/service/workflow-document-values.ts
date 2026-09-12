import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import { MAX_WORKFLOW_QUERY_ROWS, type WorkflowDocumentDataCapture, WorkflowValuesPayloadSchema } from "../workflows/query-contracts";
import { canonicalDocumentJson } from "./document-json";
import { documentServiceText } from "./document-messages";

export const WORKFLOW_DOCUMENT_VALUE_TYPES = ["text", "decimal", "boolean", "date", "dateTime", "json"] as const;
export const WorkflowDocumentValuesSchema = z
  .object({
    columns: z
      .array(
        z
          .object({
            key: z.string().min(1),
            label: z.string().trim().min(1).optional(),
            type: z.enum(WORKFLOW_DOCUMENT_VALUE_TYPES),
          })
          .strict(),
      )
      .min(1),
    rows: z.array(z.record(z.string(), z.json())).max(MAX_WORKFLOW_QUERY_ROWS),
  })
  .strict();

const cells = {
  text: z.string(),
  decimal: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/),
  boolean: z.boolean(),
  date: z.iso.date(),
  dateTime: z.iso.datetime({ offset: true }),
  json: z.json(),
};
const sqlTypes = { text: "text", decimal: "numeric", boolean: "boolean", date: "date", dateTime: "timestamptz", json: "jsonb" };

/** Captures evaluated workflow values, not text templates. Types are explicit
 * so an exact amount never passes through a binary floating point conversion. */
export const captureWorkflowDocumentValues = (input: unknown, capturedAt: string, locale?: string): Result<WorkflowDocumentDataCapture> => {
  const t = documentServiceText(locale);
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail(err.badInput(t.tableOutputDataInvalid));
    if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      return fail(err.badInput(t.tableOutputDataInvalid));
    const parsed = WorkflowDocumentValuesSchema.safeParse(canonicalDocumentJson(Object.fromEntries(Object.entries(input)), locale).value);
    if (!parsed.success) return fail(err.badInput(t.tableOutputDataInvalid));
    const { columns, rows } = parsed.data;
    const keys = new Set(columns.map((column) => column.key));
    if (keys.size !== columns.length || new Set(columns.map((column) => column.label ?? column.key)).size !== columns.length)
      return fail(err.badInput(t.tableOutputColumnsInvalid));
    for (const [index, row] of rows.entries()) {
      if (Object.keys(row).some((key) => !keys.has(key))) return fail(err.badInput(t.tableOutputDataInvalid));
      for (const column of columns) {
        if (!Object.hasOwn(row, column.key) || !cells[column.type].nullable().safeParse(row[column.key]).success)
          return fail(err.badInput(t.tableOutputCellInvalid({ row: index + 1, column: (column.label ?? column.key).slice(0, 200) })));
      }
    }
    const payload = WorkflowValuesPayloadSchema.parse({
      version: 2,
      source: { kind: "values" },
      schemaHash: null,
      context: {},
      tableIds: [],
      selectionLimit: null,
      columns: columns.map((column) => ({ ...column, label: column.label ?? column.key, sqlType: sqlTypes[column.type] })),
      rows,
      rowCount: rows.length,
      rowOrigins: rows.map(() => ({ tableId: null, recordId: null })),
      capturedAt,
      complete: true,
    });
    return ok({ payload, sha256: canonicalDocumentJson(payload, locale).sha256, hashVersion: 2, rowCount: rows.length, capturedAt });
  } catch {
    return fail(err.badInput(t.tableOutputDataInvalid));
  }
};
