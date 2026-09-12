import { isSEPACountry, isValidBIC, isValidIBAN } from "ibantools";
import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cs}]*$/u);
const identity = text(200).refine((value) => value.trim() === value, "Identity must not have surrounding whitespace.");
const iban = z
  .string()
  .max(34)
  .regex(/^[A-Z]{2}\d{2}[A-Z0-9]+$/)
  .refine(
    (value) => isValidIBAN(value, { allowQRIBAN: false }) && isSEPACountry(value.slice(0, 2)),
    "Use a valid SEPA IBAN, not a QR-IBAN.",
  );
const bic = z.string().max(11).refine(isValidBIC, "Invalid BIC.");
const basicSepaCharacters = /^[A-Za-z0-9+?/:().,' -]+$/;
const paymentId = z
  .string()
  .min(1)
  .max(35)
  .regex(basicSepaCharacters)
  .refine((value) => !value.startsWith("/") && !value.endsWith("/") && !value.includes("//"), "Invalid payment identifier.");

export const SepaTransferSchema = z
  .object({
    businessId: identity,
    endToEndId: paymentId,
    amount: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,8})\.\d{2}$/)
      .refine((value) => /[1-9]/.test(value), "Amount must be positive."),
    creditorName: text(70),
    creditorIban: iban,
    creditorBic: bic.optional(),
    remittance: text(140),
  })
  .strict();

export const SepaHeaderSchema = z
  .object({
    destinationKey: identity,
    debtorName: text(70),
    debtorIban: iban,
    debtorBic: bic.optional(),
    executionDate: z.iso.date(),
  })
  .strict();

export const SepaBatchSchema = SepaHeaderSchema.extend({
  messageId: paymentId,
  paymentInformationId: paymentId,
  rows: z.array(SepaTransferSchema).min(1).max(10_000),
}).superRefine((input, ctx) => {
  for (const key of ["businessId", "endToEndId"] as const) {
    const seen = new Set<string>();
    input.rows.forEach((row, index) => {
      if (seen.has(row[key])) ctx.addIssue({ code: "custom", path: ["rows", index, key], message: "Duplicate payment identity." });
      seen.add(row[key]);
    });
  }
});

// Advisory only: banks may accept an agreed extended character set. Never
// transliterate names or change the captured execution date during issuance.
export const sepaPreviewWarnings = (input: z.infer<typeof SepaBatchSchema>, today: string) => {
  const warnings: ("extendedCharacters" | "pastExecutionDate")[] = [];
  if (
    !basicSepaCharacters.test(input.debtorName) ||
    input.rows.some((row) => !basicSepaCharacters.test(row.creditorName) || !basicSepaCharacters.test(row.remittance))
  )
    warnings.push("extendedCharacters");
  if (input.executionDate < today) warnings.push("pastExecutionDate");
  return warnings;
};
