import { einvoice, type Invoice } from "../src/finance";
import { unwrap } from "../src/result";
import { invoice } from "./einvoice";

// The caller chooses the net basis and the adjustment explicitly.
// VAT remains 15.97; this does not preserve a gross split with VAT 15.96.
const { lines, ...totals } = unwrap(einvoice.calculate([
  { id: "1", name: "Item", quantity: "1", unitPrice: "84.03", unitCode: "C62", taxRate: "19" },
], { roundingAmount: "-0.01" }));
export const roundedInvoice: Invoice = { ...invoice, lines, totals };
export const generated = unwrap(einvoice.serialize(roundedInvoice, { format: "zugferd-2.5-en16931" }));
export const parsed = unwrap(einvoice.parseXml(generated.xml));
unwrap(einvoice.validate(parsed.invoice));
if (unwrap(einvoice.serialize(parsed.invoice, { format: generated.format })).xml !== generated.xml) throw new Error("Roundtrip changed XML bytes.");
