import { CODE_FILE_LIMITS, CodeChartDescriptionSchema } from "@k2b/cloud/code";
import { CAPABILITY_MAX_REQUEST_BYTES, type CapabilityExecutionContext, type CapabilityQueryDefinition } from "@k2b/cloud/contracts";
import { getGotenbergConfig, renderHtmlToPdfWithConfig } from "@k2b/cloud/services";
import { chartRenderOptions, drawChart } from "@k2b/editor/charts";
import { err } from "@k2b/stdlib";
import { datev, sepa } from "@k2b/stdlib/finance";
import { writeOds } from "hucre/ods";
import { z } from "zod";
import { cacheGeneratedFile, readGeneratedFile, reserveGeneratedFile } from "./cache";
import { chartInput, csvInput, datevInput, odsInput, pdfInput, sepaInput } from "./contracts";

const encode = (value: string) => new TextEncoder().encode(value);
export const renderCsv = (input: z.infer<typeof csvInput>, locale: string) => {
  const delimiter = input.delimiter ?? ";";
  const decimal = delimiter === "," ? "." : new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")!.value;
  const columns = [...new Set(input.rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: string | number | boolean | null | undefined) => {
    let text = value === null || value === undefined ? "" : typeof value === "number" ? String(value).replace(".", decimal) : String(value);
    if (/^[\s\uFEFF]*[=+\-@\t\r]/u.test(text) && typeof value !== "number") text = `'${text}`;
    return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return encode(
    `${input.bom === false ? "" : "\uFEFF"}${[columns.map(cell).join(delimiter), ...input.rows.map((row) => columns.map((name) => cell(row[name])).join(delimiter))].join("\r\n")}\r\n`,
  );
};
const generatedFileStore = { reserve: reserveGeneratedFile, put: cacheGeneratedFile, read: readGeneratedFile };
export function createGeneratedFileQueries(store = generatedFileStore) {
  function generatedFileQuery<S extends z.ZodType<{ name: string }>>(
    title: string,
    description: string,
    input: S,
    mediaType: string,
    render: (input: z.output<S>, context: CapabilityExecutionContext) => Promise<Uint8Array> | Uint8Array,
  ): CapabilityQueryDefinition<S, z.ZodObject<{ generated: z.ZodBoolean }>> {
    return {
      title,
      description,
      input,
      data: z.strictObject({ generated: z.boolean() }),
      openWorld: false,
      stream: { direction: "read", maxBytes: CODE_FILE_LIMITS.fileBytes, read: store.read },
      run: async (raw, context) => {
        // The capability transport applies this same limit; retain it for in-process callers.
        if (Buffer.byteLength(JSON.stringify(raw)) > CAPABILITY_MAX_REQUEST_BYTES)
          return {
            ok: false,
            error: { code: "BAD_INPUT", message: "Generation input exceeds the capability request budget.", status: 400 },
          };
        const parsed = input.safeParse(raw);
        if (!parsed.success) return { ok: false, error: { code: "BAD_INPUT", message: "Invalid file generation input.", status: 400 } };
        const reservation = await store.reserve(context);
        const bytes = await render(parsed.data, context);
        return {
          ok: true,
          data: { data: { generated: true }, stream: await store.put(bytes, parsed.data.name, mediaType, context, reservation) },
        };
      },
    };
  }
  return {
    "file.pdf.render.v1": generatedFileQuery(
      "Create PDF",
      "Render offline HTML as a temporary PDF file. Returns a read stream; saving or sending is a separate Action.",
      pdfInput,
      "application/pdf",
      async (input, context) => {
        const config = await getGotenbergConfig();
        return (
          await renderHtmlToPdfWithConfig(
            { ...input, tagged: input.tagged ?? true },
            { ...config, maxPdfBytes: Math.min(config.maxPdfBytes, CODE_FILE_LIMITS.fileBytes) },
            { signal: context.signal },
          )
        ).pdf;
      },
    ),
    "file.sheet.to-csv.v1": generatedFileQuery(
      "Create CSV",
      "Create a temporary CSV spreadsheet, with escaped cells and locale-aware decimals. Saving is a separate Action.",
      csvInput,
      "text/csv",
      (input, context) => renderCsv(input, context.locale),
    ),
    "file.sheet.to-ods.v1": generatedFileQuery(
      "Create spreadsheet",
      "Create a temporary OpenDocument spreadsheet of plain cells. Saving is a separate Action.",
      odsInput,
      "application/vnd.oasis.opendocument.spreadsheet",
      async (input) => {
        if (new Set(input.sheets.map((sheet) => sheet.name.toLowerCase())).size !== input.sheets.length)
          throw Object.assign(new Error("Spreadsheet names must be unique."), { code: "BAD_INPUT", status: 400 });
        return writeOds({ sheets: input.sheets });
      },
    ),
    "file.finance.datev.v1": generatedFileQuery(
      "Create DATEV file",
      "Validate and serialize a DATEV batch as a temporary CSV. This neither submits accounts nor stores the file.",
      datevInput,
      "text/csv",
      (input) => {
        const result = datev.serialize(input.batch);
        if (!result.ok) throw result.error;
        return result.data.bytes;
      },
    ),
    "file.finance.sepa.v1": generatedFileQuery(
      "Create SEPA file",
      "Validate and serialize a temporary SCT payment XML. This neither submits payments nor stores the file.",
      sepaInput,
      "application/xml",
      (input) => {
        const result = sepa.serialize(input.batch);
        if (!result.ok) throw result.error;
        return result.data.bytes;
      },
    ),
    "file.chart.render.v1": generatedFileQuery(
      "Create chart file",
      "Render a checked chart description as a temporary SVG file. Saving is a separate Action.",
      chartInput,
      "image/svg+xml",
      (input, context) => {
        const chart = CodeChartDescriptionSchema.safeParse(input.chart);
        if (!chart.success) throw err.badInput("Invalid chart description.");
        return encode(drawChart(chartRenderOptions(chart.data, context.locale)));
      },
    ),
  };
}
export const generatedFileQueries = createGeneratedFileQueries();
