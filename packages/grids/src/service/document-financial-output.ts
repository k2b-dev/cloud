import { err, fail, ok, type Result } from "@k2b/stdlib";
import Decimal from "decimal.js";
import { z } from "zod";
import { DatevBatchSchema, DatevHeaderSchema } from "../document-profiles/datev-csv-contracts";
import { SepaBatchSchema, SepaHeaderSchema } from "../document-profiles/sepa-xml-contracts";
import type { WorkflowDocumentDataCapture } from "../workflows/query-contracts";
import { canonicalDocumentJson } from "./document-json";
import { documentServiceText } from "./document-messages";

const column = z.string().min(1).max(200);

export const FinancialDocumentOutputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("datev-csv"),
      version: z.literal(1),
      header: DatevHeaderSchema,
      mapping: z
        .object({
          businessId: column,
          entryId: column,
          amount: column,
          direction: column,
          account: column,
          counterAccount: column,
          documentDate: column,
          documentNumber: column,
          text: column.optional(),
          taxKey: column.optional(),
          costCenter1: column.optional(),
          costCenter2: column.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sepa-xml"),
      version: z.literal(1),
      header: SepaHeaderSchema,
      mapping: z
        .object({
          businessId: column,
          endToEndId: column,
          amount: column,
          creditorName: column,
          creditorIban: column,
          creditorBic: column.optional(),
          remittance: column,
        })
        .strict(),
    })
    .strict(),
]);
export type FinancialDocumentOutput = z.infer<typeof FinancialDocumentOutputSchema>;
export type NormalizedFinancialOutput =
  | { kind: "datev-csv"; purpose: "accounting"; input: z.infer<typeof DatevBatchSchema>; sha256: string }
  | { kind: "sepa-xml"; purpose: "payment"; input: z.infer<typeof SepaBatchSchema>; sha256: string };

/** The preview and serializer consume the same normalized values. No rounding,
 * inferred columns, cell templates, or accidental floating-point money. */
export const normalizeFinancialDocumentOutput = (
  output: FinancialDocumentOutput,
  data: WorkflowDocumentDataCapture["payload"],
  identifiers: { messageId: string; paymentInformationId: string },
  locale?: string,
): Result<NormalizedFinancialOutput> => {
  const t = documentServiceText(locale);
  const parsed = FinancialDocumentOutputSchema.safeParse(output);
  if (!parsed.success) return fail(err.badInput(t.tableOutputInvalid));
  const config = parsed.data;
  // GQL stores cells under compiler keys such as q_col_0. Authors map the
  // selected aliases (labels), never those implementation-generated keys.
  const columns = new Map(data.columns.map((column) => [column.label, column]));
  if (columns.size !== data.columns.length || new Set(data.columns.map((column) => column.key)).size !== data.columns.length)
    return fail(err.badInput(t.financialColumnsInvalid));
  for (const key of Object.values(config.mapping)) {
    if (key !== undefined && !columns.has(key)) return fail(err.badInput(t.financialColumnMissing({ column: key })));
  }
  const rows: Record<string, unknown>[] = [];
  for (const [index, source] of data.rows.entries()) {
    const row: Record<string, unknown> = {};
    for (const [key, alias] of Object.entries(config.mapping)) {
      if (alias === undefined) continue;
      const column = columns.get(alias);
      if (!column || !Object.hasOwn(source, column.key)) return fail(err.badInput(t.financialColumnMissing({ column: alias })));
      if (source[column.key] !== null) row[key] = source[column.key];
    }
    const raw = row.amount;
    const amount = typeof raw === "string" ? raw : typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : null;
    if (amount === null || amount.length > 200 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount))
      return fail(err.badInput(t.financialAmountInvalid({ row: index + 1 })));
    const decimal = new Decimal(amount);
    if (decimal.decimalPlaces() > 2 || !decimal.gt(0)) return fail(err.badInput(t.financialAmountInvalid({ row: index + 1 })));
    row.amount = decimal.toFixed(2);
    rows.push(row);
  }
  const candidate =
    config.kind === "datev-csv"
      ? DatevBatchSchema.safeParse({ ...config.header, rows })
      : SepaBatchSchema.safeParse({ ...config.header, ...identifiers, rows });
  if (!candidate.success) {
    const paths = candidate.error.issues
      .slice(0, 8)
      .map((issue) => issue.path.join("."))
      .join(", ");
    return fail(err.badInput(t.financialValuesInvalid({ fields: paths })));
  }
  const sha256 = canonicalDocumentJson(candidate.data, locale).sha256;
  // Keep the discriminant correlated with its parsed input rather than casting
  // one financial schema into the other.
  if (config.kind === "datev-csv") {
    return ok({ kind: config.kind, purpose: "accounting", input: DatevBatchSchema.parse(candidate.data), sha256 });
  }
  return ok({ kind: config.kind, purpose: "payment", input: SepaBatchSchema.parse(candidate.data), sha256 });
};
