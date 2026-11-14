import { CODE_FILE_LIMITS, CodeChartDescriptionSchema } from "@k2b/cloud/code";
import { CAPABILITY_MAX_REQUEST_BYTES } from "@k2b/cloud/contracts";
import { z } from "zod";

const text = z
  .string()
  .max(CAPABILITY_MAX_REQUEST_BYTES)
  .describe("Text field in the stdlib finance batch; format validation runs before serialization.");
const name = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\\/\p{Cc}\p{Cf}]+$/u)
  .refine((value) => value !== "." && value !== "..")
  .describe("Output filename without directories or control characters.");
const scalar = z.union([z.string().max(CAPABILITY_MAX_REQUEST_BYTES), z.number().finite(), z.boolean(), z.null()]);
const margin = z.number().nonnegative().describe("Margin in millimetres.");
export const pdfInput = z.strictObject({
  name,
  html: text.min(1).describe("Offline HTML document. Scripts and remote resources are disabled."),
  title: text.optional().describe("PDF document title; an existing HTML title wins."),
  headerHtml: text.optional().describe("Offline HTML header."),
  footerHtml: text.optional().describe("Offline HTML footer."),
  page: z
    .strictObject({
      format: z.enum(["A4", "A3", "A5", "Letter", "Legal"]).optional().describe("Paper format; defaults to A4."),
      landscape: z.boolean().optional().describe("Use landscape orientation."),
      margin: z
        .strictObject({ top: margin.optional(), right: margin.optional(), bottom: margin.optional(), left: margin.optional() })
        .optional()
        .describe("Page margins in millimetres."),
    })
    .optional()
    .describe("Page size, orientation and margins."),
  tagged: z.boolean().optional().describe("Generate a tagged PDF; defaults to true."),
});
export const csvInput = z.strictObject({
  name,
  rows: z.array(z.record(z.string(), scalar)).describe("Rows of plain cells; column order follows first appearance."),
  delimiter: z
    .enum([",", ";", "\t"])
    .optional()
    .describe("Column separator; defaults to semicolon. Comma-separated files use dot decimals."),
  bom: z.boolean().optional().describe("Include a UTF-8 BOM; defaults to true."),
});
export const odsInput = z.strictObject({
  name,
  sheets: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(31)
          .regex(/^[^\[\]:*?/\\]+$/)
          .describe("Unique worksheet name, at most 31 characters."),
        rows: z.array(z.array(scalar)).describe("Rows of plain string, number, boolean or empty cells. Strings are never formulas."),
      }),
    )
    .min(1)
    .max(CODE_FILE_LIMITS.files)
    .describe("Worksheets in output order."),
});
// Publish the shared chart transport without weakening its renderer validation.
// Some shared chart fields have no description; name those options for the
// capability catalog while retaining the shared field shapes and bounds.
const chartTransport = z.fromJSONSchema(
  z.toJSONSchema(CodeChartDescriptionSchema, {
    io: "input",
    override: ({ jsonSchema }) => {
      if (jsonSchema.type === "object" && jsonSchema.additionalProperties === undefined) jsonSchema.additionalProperties = false;
      for (const [field, schema] of Object.entries(jsonSchema.properties ?? {})) {
        if (typeof schema === "object" && schema && !schema.description)
          schema.description = `Chart ${field} option from the shared chart description.`;
      }
    },
  }),
);
export const chartInput = z.strictObject({
  name,
  chart: chartTransport.describe("Checked chart description, as used by Code pages, including a title."),
});
// Transport shapes expose stdlib's public batch fields; stdlib remains the
// authority for exact amounts, dates, bank formats and cross-field validation.
export const datevInput = z.strictObject({
  name,
  batch: z
    .strictObject({
      format: z.literal("datev-700-13").describe("DATEV serialization format."),
      currency: z.literal("EUR").describe("Batch currency."),
      applicationInformation: text.optional(),
      consultantNumber: text,
      clientNumber: text,
      fiscalYearStart: text,
      accountLength: z.number().int().describe("DATEV account length, 4 to 8 digits."),
      periodStart: text,
      periodEnd: text,
      label: text,
      finalize: z.boolean().describe("Explicit DATEV import finalization flag."),
      createdAt: text.describe("Caller-supplied UTC timestamp with milliseconds."),
      rows: z
        .array(
          z.strictObject({
            amount: text.describe("Positive exact EUR decimal, for example 12.50."),
            direction: z.enum(["S", "H"]).describe("S debit or H credit."),
            account: text,
            counterAccount: text,
            documentDate: text,
            documentNumber: text,
            text: text.optional(),
            taxKey: text.optional(),
            costCenter1: text.optional(),
            costCenter2: text.optional(),
          }),
        )
        .min(1)
        .describe("DATEV postings in output order."),
    })
    .describe("DATEV batch, validated by stdlib."),
});
export const sepaInput = z.strictObject({
  name,
  batch: z
    .strictObject({
      format: z.literal("sepa-sct-pain.001.001.09-gbic-5").describe("SEPA SCT serialization format."),
      currency: z.literal("EUR").describe("Batch currency."),
      debtorName: text,
      debtorIban: text,
      debtorBic: text.optional(),
      executionDate: text,
      createdAt: text.describe("Caller-supplied UTC timestamp with milliseconds."),
      messageId: text,
      paymentInformationId: text,
      rows: z
        .array(
          z.strictObject({
            endToEndId: text,
            amount: text.describe("Positive exact EUR decimal, for example 12.50."),
            creditorName: text,
            creditorIban: text,
            creditorBic: text.optional(),
            remittance: text,
          }),
        )
        .min(1)
        .describe("SEPA transfers in output order, with unique end-to-end IDs."),
    })
    .describe("SEPA SCT batch, validated by stdlib."),
});
