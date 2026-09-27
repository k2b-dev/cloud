import type { Invoice } from "@k2b/stdlib/finance";

/** A valid EN 16931 invoice for the Code Mode Factur-X tests. */
export const invoice = {
  kind: "invoice",
  number: "TEST-42",
  invoiceDate: "2026-09-15",
  serviceDate: "2026-09-15",
  dueDate: "2026-09-30",
  currency: "EUR",
  seller: {
    name: "Example Seller",
    vatId: "DE123456789",
    address: { line1: "Street 1", city: "Ulm", postalCode: "89073", countryCode: "DE" },
  },
  buyer: {
    name: "Example Buyer",
    vatId: "DE987654321",
    address: { line1: "Street 2", city: "Berlin", postalCode: "10115", countryCode: "DE" },
  },
  buyerReference: "TEST",
  payment: { iban: "DE89370400440532013000", accountName: "Example Seller" },
  lines: [{ id: "1", name: "Service", quantity: "2.0000", unitPrice: "50.0000", unitCode: "HUR", taxRate: "19.00" }],
} satisfies Invoice;
