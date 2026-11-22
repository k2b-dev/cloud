import { isSEPACountry, isValidBIC, isValidIBAN } from "ibantools";
import { z } from "zod";

// DK Appendix 3 v3.9, section 2.1: Latin set plus required German extensions.
const text = (max: number) => z.string().min(1).max(max)
  .regex(/^[A-Za-z0-9+?/:().,' &*$%ÄÖÜäöüß-]+$/, "Unsupported DK SEPA character.")
  .refine(value => value.trim().length > 0, "Expected nonblank text.");
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
  .refine(value => value.trim().length > 0, "Expected a nonblank payment identifier.")
  .refine((value) => !value.startsWith("/") && !value.endsWith("/") && !value.includes("//"), "Invalid payment identifier.");

export const SepaTransferSchema = z
  .object({
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
    format: z.literal("sepa-sct-pain.001.001.09-gbic-5"),
    currency: z.literal("EUR"),
    debtorName: text(70),
    debtorIban: iban,
    debtorBic: bic.optional(),
    executionDate: z.iso.date().refine(value => !value.startsWith("0000-"), "XML Schema dates require a nonzero year."),
  })
  .strict();

export const SepaBatchSchema = SepaHeaderSchema.extend({
  createdAt: z.iso.datetime({ precision: 3 }).refine(value => !value.startsWith("0000-"), "XML Schema dates require a nonzero year."),
  messageId: paymentId,
  paymentInformationId: paymentId,
  rows: z.array(SepaTransferSchema).min(1),
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  input.rows.forEach((row, index) => {
    if (seen.has(row.endToEndId)) ctx.addIssue({ code: "custom", path: ["rows", index, "endToEndId"], message: "Duplicate end-to-end identifier." });
    seen.add(row.endToEndId);
  });
});

export type SepaTransfer = z.infer<typeof SepaTransferSchema>;
export type SepaBatch = z.infer<typeof SepaBatchSchema>;
export type SepaHeader = z.infer<typeof SepaHeaderSchema>;
