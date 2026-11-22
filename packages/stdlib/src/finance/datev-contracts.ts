import { z } from "zod";
import { datevGuid } from "./datev-guid";

const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}\p{Cs}]*$/u, "Control characters are not allowed.");
const date = z.iso.date().refine((value) => value >= "2000-01-01" && value <= "2099-12-31", "DATEV dates must be in 2000–2099.");
const account = z.string().regex(/^(?!0+$)\d{1,9}$/);
const costCenter = text(36).regex(/^[\p{L}\p{N}_ ]*$/u);

export const DatevPostingSchema = z
  .object({
    amount: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/)
      .refine((value) => /[1-9]/.test(value), "Amount must be positive."),
    direction: z.enum(["S", "H"]),
    account,
    counterAccount: account,
    documentDate: date,
    documentNumber: text(36)
      .min(1)
      .regex(/^[A-Za-z0-9_$&%*+\-/]+$/),
    /** Document GUID from Belegtransfer; serialized as BEDI "<GUID>" in column 20. */
    documentGuid: datevGuid.optional(),
    text: text(60).optional(),
    taxKey: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    costCenter1: costCenter.optional(),
    costCenter2: costCenter.optional(),
  })
  .strict();

export const DatevHeaderSchema = z
  .object({
    format: z.literal("datev-700-13"),
    currency: z.literal("EUR"),
    applicationInformation: text(16).optional(),
    consultantNumber: z
      .string()
      .regex(/^[1-9]\d{3,6}$/)
      .refine((value) => Number(value) >= 1001),
    clientNumber: z.string().regex(/^[1-9]\d{0,4}$/),
    fiscalYearStart: date,
    accountLength: z.number().int().min(4).max(8),
    periodStart: date,
    periodEnd: date,
    label: text(30)
      .min(1)
      .regex(/^[\p{L}\p{N}_.\-/ ]+$/u),
    // DATEV import finalization, supplied explicitly by the caller.
    finalize: z.boolean(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!date.safeParse(input.fiscalYearStart).success) return;
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const start = new Date(`${input.fiscalYearStart}T00:00:00Z`);
    const nextYear = new Date(start);
    nextYear.setUTCFullYear(start.getUTCFullYear() + 1);
    const endExclusive = nextYear.toISOString().slice(0, 10);
    if (input.periodStart < input.fiscalYearStart || input.periodEnd >= endExclusive || input.periodStart > input.periodEnd)
      issue(["periodEnd"], "The posting period must lie within one fiscal year.");
  });

export const DatevBatchSchema = DatevHeaderSchema.safeExtend({
  createdAt: z.iso.datetime({ precision: 3 }).refine((value) => value.startsWith("20"), "DATEV timestamps must be in 2000–2099."),
  rows: z.array(DatevPostingSchema).min(1),
}).superRefine((input, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  input.rows.forEach((row, index) => {
    if (row.documentDate < input.periodStart || row.documentDate > input.periodEnd)
      issue(["rows", index, "documentDate"], "The document date must lie within the posting period.");
    for (const key of ["account", "counterAccount"] as const) {
      if (row[key].length > input.accountLength + 1)
        issue(["rows", index, key], "Account exceeds the configured account length plus one person-account digit.");
    }
  });
});

export type DatevPosting = z.infer<typeof DatevPostingSchema>;
export type DatevBatch = z.infer<typeof DatevBatchSchema>;
export type DatevHeader = z.infer<typeof DatevHeaderSchema>;
