import { einvoice, type Invoice } from "../src/finance";
import { invoice } from "./einvoice";

/** Invoice price includes the margin VAT; no separate VAT is disclosed. */
export const marginInvoice: Invoice = {
  ...invoice,
  number: "RE-2026-ANTIQUES-1",
  lines: [{
    id: "1", name: "Antiker Schrank", quantity: "1", unitPrice: "1200.00",
    unitCode: "C62", taxCategory: "E", taxRate: "0",
    taxExemptionReason: "Sammlungsstücke und Antiquitäten/Sonderregelung (§ 25a UStG)",
    taxExemptionReasonCode: "VATEX-EU-J",
  }],
};
export const generatedMarginInvoice = einvoice.serialize(marginInvoice, { format: "zugferd-2.5-en16931" });
