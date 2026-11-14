import { datev } from "@k2b/stdlib/finance";
import { z } from "zod";

// Grids owns identities and transport shapes; stdlib owns format semantics.
const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Cs}]*$/u)
  .refine((value) => value.trim() === value, "Identity must not have surrounding whitespace.");
export const DatevPostingSchema = z
  .object({
    businessId: identity.describe("Stable business transaction identity for duplicate-export protection."),
    entryId: identity.describe("Stable entry identity within its business transaction."),
    amount: z.string().describe("Exact positive decimal amount."),
    direction: z.enum(["S", "H"]).describe("Debit S or credit H."),
    account: z.string().describe("Ledger account."),
    counterAccount: z.string().describe("Counter-account."),
    documentDate: z.string().describe("Document calendar date."),
    documentNumber: z.string().describe("Document number."),
    text: z.string().optional().describe("Posting text."),
    taxKey: z.string().optional().describe("Tax code."),
    costCenter1: z.string().optional().describe("First cost center."),
    costCenter2: z.string().optional().describe("Second cost center."),
  })
  .strict();

export const DatevHeaderSchema = z
  .object({
    destinationKey: identity.describe("Stable accounting or bank destination identity."),
    consultantNumber: z.string().describe("DATEV consultant number."),
    clientNumber: z.string().describe("DATEV client number."),
    fiscalYearStart: z.string().describe("Fiscal-year start, YYYY-MM-DD."),
    accountLength: z.number().describe("DATEV account number length."),
    periodStart: z.string().describe("Booking period start, YYYY-MM-DD."),
    periodEnd: z.string().describe("Booking period end, YYYY-MM-DD."),
    label: z.string().describe("Output label."),
    finalize: z.boolean().describe("Whether DATEV marks the booking batch finalized."),
  })
  .strict()
  .superRefine((input, ctx) => {
    const { consultantNumber, clientNumber, fiscalYearStart, accountLength, periodStart, periodEnd, label, finalize } = input;
    const header = { consultantNumber, clientNumber, fiscalYearStart, accountLength, periodStart, periodEnd, label, finalize };
    const result = datev.validateHeader({ ...header, format: "datev-700-13", currency: "EUR" });
    if (!result.ok)
      for (const issue of result.error.issues ?? []) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });

export const DatevBatchSchema = DatevHeaderSchema.safeExtend({ rows: z.array(DatevPostingSchema).min(1).max(10_000) }).superRefine(
  (input, ctx) => {
    const entries = new Map<string, Set<string>>();
    input.rows.forEach((row, index) => {
      const keys = entries.get(row.businessId) ?? new Set<string>();
      if (keys.has(row.entryId))
        ctx.addIssue({ code: "custom", path: ["rows", index, "entryId"], message: "Duplicate entry within the business transaction." });
      keys.add(row.entryId);
      entries.set(row.businessId, keys);
    });
  },
);

export const datevFormatInput = (input: z.infer<typeof DatevBatchSchema>, createdAt: string) => {
  const { destinationKey: _, rows, ...header } = input;
  return {
    ...header,
    format: "datev-700-13" as const,
    currency: "EUR" as const,
    applicationInformation: "Grids",
    createdAt,
    rows: rows.map(({ businessId: _, entryId: __, ...posting }) => posting),
  };
};
