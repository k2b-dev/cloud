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
    businessId: identity,
    entryId: identity,
    amount: z.string(),
    direction: z.enum(["S", "H"]),
    account: z.string(),
    counterAccount: z.string(),
    documentDate: z.string(),
    documentNumber: z.string(),
    text: z.string().optional(),
    taxKey: z.string().optional(),
    costCenter1: z.string().optional(),
    costCenter2: z.string().optional(),
  })
  .strict();

export const DatevHeaderSchema = z
  .object({
    destinationKey: identity,
    consultantNumber: z.string(),
    clientNumber: z.string(),
    fiscalYearStart: z.string(),
    accountLength: z.number(),
    periodStart: z.string(),
    periodEnd: z.string(),
    label: z.string(),
    finalize: z.boolean(),
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
