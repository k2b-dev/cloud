import type { Invoice } from "../src/finance";
import { invoice } from "./einvoice";

/** Additional amounts only; this invoice references, rather than replaces, the original. */
export const additionalInvoice: Invoice = {
  ...invoice, number: "RE-2026-000002", payment: { typeCode: "68", information: "PayPal" },
  serviceDate: undefined, period: { startDate: "2026-08-01", endDate: "2026-08-15" },
  precedingInvoice: { number: "RE-2026-000000", invoiceDate: "2026-08-01" },
  lines: [{ ...invoice.lines[0]!, quantity: "1", unitPrice: "25.00" }],
};

/** Positive credited amounts; no instruction to pay the seller's bank account. */
export const creditNote: Invoice = { ...additionalInvoice, kind: "creditNote", payment: undefined };

/** Additional self-billed amount, retaining the buyer-issued document type 389. */
export const additionalSelfBilling: Invoice = { ...additionalInvoice, kind: "selfBilling", payment: { typeCode: "97" } };

/** A reduction issued by the buyer in self-billing uses type 261. */
export const selfBillingCreditNote: Invoice = { ...creditNote, kind: "selfBillingCreditNote" };
