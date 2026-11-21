import { CODE_FILE_LIMITS, CodeChartDescriptionSchema } from "@k2b/cloud/code";
import { CAPABILITY_MAX_REQUEST_BYTES } from "@k2b/cloud/contracts";
import { z } from "zod";

const text = z.string().max(CAPABILITY_MAX_REQUEST_BYTES).describe("Finance text; validated by stdlib.");
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
type JsonNode = Record<string, unknown>;
const isNode = (value: unknown): value is JsonNode => typeof value === "object" && value !== null && !Array.isArray(value);
const stableKey = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stableKey).join(",")}]`
    : isNode(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const withoutDescription = ({ description: _description, ...rest }: JsonNode): JsonNode => rest;
/** Subschema positions in the chart transport, named by the nearest field; other keywords hold values. */
const childSchemas = (node: JsonNode, field: string): Array<[field: string, child: unknown]> =>
  Object.entries(node).flatMap(([key, value]): Array<[string, unknown]> => {
    if (key === "properties" && isNode(value)) return Object.entries(value);
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) return value.map((child) => [field, child]);
    if (key === "items" || key === "additionalProperties") return [[field, value]];
    return [];
  });
/**
 * The chart description repeats the same option groups (number formats, tooltips, labelled values) in
 * every chart kind. Inlined, that one Query was the largest part of Core's registry manifest. Every
 * repeated subschema is published once under `$defs`; each use keeps its own description. Zod
 * resolves a `$ref` to one schema carrying the `id`, so validation and the manifest describe exactly
 * the same values as the inlined form.
 */
const shareRepeatedSchemas = (schema: JsonNode, idPrefix: string): JsonNode => {
  const MIN_SHARED_CHARS = 40;
  const seen = new Map<string, { count: number; field: string }>();
  const count = (node: unknown, field: string) => {
    if (!isNode(node)) return;
    const key = stableKey(withoutDescription(node));
    const entry = seen.get(key);
    if (entry) entry.count += 1;
    else seen.set(key, { count: 1, field });
    for (const [childField, child] of childSchemas(node, field)) count(child, childField);
  };
  for (const [field, child] of childSchemas(schema, "chart")) count(child, field);
  const build = (inlined: ReadonlySet<string>) => {
    const names = new Map<string, string>();
    const taken = new Set<string>();
    for (const [key, { count: uses, field }] of seen) {
      if (uses < 2 || key.length < MIN_SHARED_CHARS || inlined.has(key)) continue;
      const base = `${idPrefix}${field.replace(/(?:^|[^A-Za-z0-9])([A-Za-z0-9])/g, (_, letter: string) => letter.toUpperCase())}`;
      let name = base;
      for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}${suffix}`;
      taken.add(name);
      names.set(key, name);
    }
    const $defs: Record<string, JsonNode> = {};
    const rewrite = (node: JsonNode): JsonNode =>
      Object.fromEntries(
        Object.entries(node).map(([key, value]) => {
          if (key === "properties" && isNode(value))
            return [key, Object.fromEntries(Object.entries(value).map(([field, child]) => [field, share(child)]))];
          if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) return [key, value.map(share)];
          if (key === "items" || key === "additionalProperties") return [key, share(value)];
          return [key, value];
        }),
      );
    const share = (node: unknown): unknown => {
      if (!isNode(node)) return node;
      const bare = withoutDescription(node);
      const name = names.get(stableKey(bare));
      if (!name) return rewrite(node);
      // `id` makes Zod emit one `$defs` entry for every reference instead of inlining it again.
      if (!$defs[name]) $defs[name] = { ...rewrite(bare), id: name };
      return node.description === undefined ? { $ref: `#/$defs/${name}` } : { $ref: `#/$defs/${name}`, description: node.description };
    };
    const shared = { ...rewrite(schema), $defs: { ...(isNode(schema.$defs) ? schema.$defs : {}), ...$defs } };
    // A repeat nested in a shared parent may end with one reference; inline those and build again.
    const json = JSON.stringify(shared);
    const single = [...names].filter(([, name]) => json.split(`"#/$defs/${name}"`).length === 2).map(([key]) => key);
    return { shared, single };
  };
  const inlined = new Set<string>();
  for (;;) {
    const { shared, single } = build(inlined);
    if (single.length === 0) return shared;
    for (const key of single) inlined.add(key);
  }
};
// Publish the shared chart transport without weakening its renderer validation.
// Some shared chart fields have no description; name those options for the
// capability catalog while retaining the shared field shapes and bounds.
const chartTransport = z.fromJSONSchema(
  shareRepeatedSchemas(
    z.toJSONSchema(CodeChartDescriptionSchema, {
      io: "input",
      override: ({ jsonSchema }) => {
        if (jsonSchema.type === "object" && jsonSchema.additionalProperties === undefined) jsonSchema.additionalProperties = false;
        for (const [field, schema] of Object.entries(jsonSchema.properties ?? {})) {
          if (typeof schema === "object" && schema && !schema.description) schema.description = `Chart ${field}.`;
        }
      },
    }),
    "CoreChart",
  ),
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
