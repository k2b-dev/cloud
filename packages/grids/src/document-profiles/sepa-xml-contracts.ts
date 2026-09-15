import { sepa } from "@k2b/stdlib/finance";
import { z } from "zod";

const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\p{Cs}]*$/u)
  .refine((value) => value.trim() === value, "Identity must not have surrounding whitespace.");
export const SepaTransferSchema = z
  .object({
    businessId: identity,
    endToEndId: z.string(),
    amount: z.string(),
    creditorName: z.string(),
    creditorIban: z.string(),
    creditorBic: z.string().optional(),
    remittance: z.string(),
  })
  .strict();

export const SepaHeaderSchema = z
  .object({
    destinationKey: identity,
    debtorName: z.string(),
    debtorIban: z.string(),
    debtorBic: z.string().optional(),
    executionDate: z.string(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const { debtorName, debtorIban, debtorBic, executionDate } = input;
    const header = { debtorName, debtorIban, debtorBic, executionDate };
    const result = sepa.validateHeader({ ...header, format: "sepa-sct-pain.001.001.09-gbic-5", currency: "EUR" });
    if (!result.ok)
      for (const issue of result.error.issues ?? []) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });

export const SepaBatchSchema = SepaHeaderSchema.safeExtend({
  messageId: z.string(),
  paymentInformationId: z.string(),
  rows: z.array(SepaTransferSchema).min(1).max(10_000),
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  input.rows.forEach((row, index) => {
    if (seen.has(row.businessId))
      ctx.addIssue({ code: "custom", path: ["rows", index, "businessId"], message: "Duplicate payment identity." });
    seen.add(row.businessId);
  });
});

export const sepaFormatInput = (input: z.infer<typeof SepaBatchSchema>, createdAt: string) => {
  const { destinationKey: _, rows, ...header } = input;
  return {
    ...header,
    format: "sepa-sct-pain.001.001.09-gbic-5" as const,
    currency: "EUR" as const,
    createdAt,
    rows: rows.map(({ businessId: _, ...transfer }) => transfer),
  };
};

// Character support is validated by stdlib, not a bank-dependent warning.
// Never change the captured execution date during issuance.
export const sepaPreviewWarnings = (input: z.infer<typeof SepaBatchSchema>, today: string): "pastExecutionDate"[] =>
  input.executionDate < today ? ["pastExecutionDate"] : [];
