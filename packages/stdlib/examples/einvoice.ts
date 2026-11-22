import { einvoice, type Invoice } from "../src/finance";

export const invoice: Invoice = {
  kind: "invoice", number: "RE-2026-000001", invoiceDate: "2026-08-22", serviceDate: "2026-08-15", dueDate: "2026-09-05", currency: "EUR",
  seller: { name: "Example Seller GmbH", vatId: "DE123456789", address: { line1: "Hauptstrasse 1", city: "Ulm", postalCode: "89073", countryCode: "DE" } },
  buyer: { name: "Example Buyer GmbH", vatId: "DE987654321", address: { line1: "Markt 2", city: "Berlin", postalCode: "10115", countryCode: "DE" } },
  buyerReference: "PUR-42", payment: { iban: "DE89370400440532013000", accountName: "Example Seller GmbH" },
  lines: [
    { id: "1", name: "Consulting", quantity: "2.0000", unitPrice: "50.0000", unitCode: "HUR", taxRate: "19.00" },
    { id: "2", name: "Books", quantity: "1.0000", unitPrice: "20.0000", unitCode: "C62", taxRate: "7.00" },
  ],
};
export const generated = einvoice.serialize(invoice, { format: "zugferd-2.5-en16931" });
if (!generated.ok) throw new Error(generated.error.message);
export const parsed = einvoice.parseXml(generated.data.xml);
