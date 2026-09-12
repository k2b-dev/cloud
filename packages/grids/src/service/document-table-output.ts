import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import type { DslQueryPreviewColumn } from "../contracts";
import type { DocumentArtifactDraft } from "../document-profiles";
import { canonicalDocumentJson } from "./document-json";
import { documentServiceText } from "./document-messages";
import { csvQuote, csvTextNeedsProtection } from "./export-csv";

export const DocumentCsvOutputSchema = z
  .object({
    kind: z.literal("csv"),
    delimiter: z.enum([",", ";", "\t", "|"]).default(","),
    nestedValues: z.enum(["reject", "json"]).default("reject"),
    textProtection: z.enum(["spreadsheet", "raw"]).default("spreadsheet"),
    columns: z
      .array(z.object({ source: z.string().min(1), label: z.string().trim().min(1).optional() }).strict())
      .min(1)
      .optional(),
  })
  .strict();

export const DocumentJsonOutputSchema = z
  .object({
    kind: z.literal("json"),
    wrapper: z
      .object({
        rowsKey: z.string().trim().min(1),
        values: z.record(z.string(), z.json()).default({}),
      })
      .strict()
      .refine((value) => !Object.hasOwn(value.values, value.rowsKey), "Wrapper values must not overwrite the rows key")
      .optional(),
  })
  .strict();

export const DocumentTableOutputSchema = z.discriminatedUnion("kind", [DocumentJsonOutputSchema, DocumentCsvOutputSchema]);

export type DocumentTableData = {
  columns: Pick<DslQueryPreviewColumn, "key" | "label" | "type" | "sqlType">[];
  rows: Record<string, unknown>[];
};

/** Serializes already authorized, complete data. It never loads Records or
 * expands relations: the caller must supply the frozen GQL result. */
export const renderDocumentTableOutput = (input: {
  data: DocumentTableData;
  output: z.input<typeof DocumentTableOutputSchema>;
  filename: string;
  locale?: string;
}): Result<{ artifact: DocumentArtifactDraft; protectedCells: number }> => {
  const t = documentServiceText(input.locale);
  const parsed = DocumentTableOutputSchema.safeParse(input.output);
  if (!parsed.success) return fail(err.badInput(t.tableOutputInvalid));
  const output = parsed.data;
  let { columns } = input.data;
  if (
    columns.length === 0 ||
    columns.some((column) => !column.key || !column.label.trim()) ||
    new Set(columns.map((column) => column.key)).size !== columns.length ||
    new Set(columns.map((column) => column.label)).size !== columns.length
  )
    return fail(err.badInput(t.tableOutputColumnsInvalid));

  if (output.kind === "csv" && output.columns) {
    const available = new Map(columns.map((column) => [column.label, column]));
    const selected: DocumentTableData["columns"] = [];
    for (const mapping of output.columns) {
      const column = available.get(mapping.source);
      if (!column) return fail(err.badInput(t.tableOutputColumnsInvalid));
      selected.push({ ...column, label: mapping.label ?? column.label });
    }
    if (
      new Set(selected.map((column) => column.key)).size !== selected.length ||
      new Set(selected.map((column) => column.label)).size !== selected.length
    )
      return fail(err.badInput(t.tableOutputColumnsInvalid));
    columns = selected;
  }

  // Use the same exact-JSON and 5 MiB input boundary as document profiles.
  // Canonicalization rejects non-JSON values rather than silently stringifying
  // undefined, NaN, class instances or cycles.
  let values: ReturnType<typeof canonicalDocumentJson>["value"];
  try {
    values = canonicalDocumentJson({ rows: input.data.rows, columns }, input.locale).value;
  } catch {
    return fail(err.badInput(t.tableOutputDataInvalid));
  }
  const frozenRows = values.rows;
  if (!Array.isArray(frozenRows)) return fail(err.badInput(t.tableOutputDataInvalid));
  const rows: Record<string, unknown>[] = [];
  let protectedCells = 0;
  const encodeCell = (value: string, numeric = false): string => {
    if (output.kind !== "csv") return value;
    const protect = !numeric && output.textProtection === "spreadsheet";
    if (protect && csvTextNeedsProtection(value)) protectedCells++;
    return csvQuote(value, output.delimiter, protect);
  };
  const csvRows: string[] = output.kind === "csv" ? [columns.map((column) => encodeCell(column.label)).join(output.delimiter)] : [];
  for (const [rowIndex, row] of frozenRows.entries()) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return fail(err.badInput(t.tableOutputDataInvalid));
    const cells: string[] = [];
    const entries: [string, unknown][] = [];
    for (const column of columns) {
      const value = row[column.key];
      const numeric = column.sqlType === "numeric";
      if (
        !Object.hasOwn(row, column.key) ||
        (value !== null &&
          numeric &&
          !(
            (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) ||
            (typeof value === "number" && Number.isSafeInteger(value))
          )) ||
        (value !== null && column.sqlType === "boolean" && typeof value !== "boolean")
      )
        return fail(err.badInput(t.tableOutputCellInvalid({ row: rowIndex + 1, column: column.label.slice(0, 200) })));
      entries.push([column.label, value]);
      if (output.kind !== "csv") continue;
      if (value !== null && typeof value === "object" && output.nestedValues === "reject") {
        return fail(err.badInput(t.tableOutputNestedValue({ row: rowIndex + 1, column: column.label.slice(0, 200) })));
      }
      cells.push(encodeCell(value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value), numeric));
    }
    if (output.kind === "csv") csvRows.push(cells.join(output.delimiter));
    else rows.push(Object.fromEntries(entries));
  }
  let serialized: string;
  try {
    if (output.kind === "csv") serialized = `${csvRows.join("\r\n")}\r\n`;
    else if (output.wrapper) {
      serialized = canonicalDocumentJson(
        Object.fromEntries([...Object.entries(output.wrapper.values), [output.wrapper.rowsKey, rows]]),
        input.locale,
      ).json;
    } else serialized = JSON.stringify(rows);
  } catch {
    return fail(err.badInput(t.tableOutputDataInvalid));
  }
  return ok({
    artifact: {
      key: output.kind,
      filename: input.filename,
      mediaType: output.kind === "csv" ? "text/csv" : "application/json",
      bytes: new TextEncoder().encode(serialized),
    },
    protectedCells,
  });
};
