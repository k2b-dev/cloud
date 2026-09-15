import { expect, test } from "bun:test";
import { UnitCode } from "@stackforge-eu/factur-x";
import { germanBillingSnapshotSchema } from "../document-profiles/einvoice-de";
import { renderDocumentProfileInput } from "../service/document-rendering";
import { billingDocumentRenderer } from "./billing-document";

const row = {
  invoice_date: "2026-09-14",
  service_date: "2026-09-01",
  due_date: "2026-09-28",
  buyer_reference: "Order 42",
  settings_name: 'Company "A"',
  settings_vat_id: "DE123456789",
  settings_street: "Test 1",
  settings_postal_code: "89073",
  settings_city: "Ulm",
  settings_iban: "DE89370400440532013000",
  settings_account_name: "Company A",
  party_name: "Company B",
  party_vat_id: "DE987654321",
  party_street: "Test 2",
  party_postal_code: "10115",
  party_city: "Berlin",
  party_iban: "DE89370400440532013000",
  party_account_name: "Company B",
  positions: [
    { Label1: 'Consulting "A"\nSecond line', Detail: null, Unit01: ["C62"], Qty001: "1.2500", Price1: "19.9900", Vat001: ["vat007"] },
  ],
  original_number: "RE-0001",
  original_date: "2026-09-01",
  reason: "Partial refund",
  agreement: "Contract 42",
};
const mappedRow = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value).flatMap(([key, value]) => [
      [`billing_${key}`, value],
      ...(key.startsWith("settings_") || key.startsWith("party_") ? [[`billing_original_${key}`, value]] : []),
    ]),
  );

for (const kind of ["invoice", "creditNote", "selfBilling"] as const) {
  for (const dateSuffix of ["", "T00:00:00.000Z"]) {
    test(`billing mapping: ${kind} uses exact values and the correct parties (${dateSuffix || "date only"})`, async () => {
      const result = await renderDocumentProfileInput(
        { renderer: billingDocumentRenderer },
        {
          rows: [
            mappedRow({
              ...row,
              kind: [kind],
              invoice_date: row.invoice_date + dateSuffix,
              service_date: row.service_date + dateSuffix,
              due_date: row.due_date + dateSuffix,
              original_date: row.original_date + dateSuffix,
            }),
          ],
        },
      );
      if (!result.ok) throw result.error;
      const input = germanBillingSnapshotSchema.parse(result.data);
      expect(input.billing.kind).toBe(kind);
      expect(input.invoiceDate).toBe(row.invoice_date);
      expect(input.serviceDate).toBe(row.service_date);
      expect(input.dueDate).toBe(row.due_date);
      expect(input.seller.name).toBe(kind === "selfBilling" ? row.party_name : row.settings_name);
      expect(input.buyer.name).toBe(kind === "selfBilling" ? row.settings_name : row.party_name);
      if (input.billing.kind === "selfBilling") expect(input.billing.agreementReference).toBe(row.agreement);
      expect(input.payment.accountName).toBe(kind === "invoice" ? row.settings_account_name : row.party_account_name);
      expect(input.lines[0]).toEqual({
        name: row.positions[0]!.Label1,
        unitCode: UnitCode.UNIT,
        quantity: "1.2500",
        unitPrice: "19.9900",
        taxRate: "7.00",
      });
      if (input.billing.kind === "creditNote") expect(input.billing.original).toEqual({ number: "RE-0001", invoiceDate: "2026-09-01" });
    });
  }
}

test("credit note keeps original identities and its own refund account", async () => {
  const result = await renderDocumentProfileInput(
    { renderer: billingDocumentRenderer },
    {
      rows: [
        {
          ...mappedRow({ ...row, kind: ["creditNote"] }),
          billing_original_settings_name: "Original issuer",
          billing_original_party_name: "Original recipient",
          billing_settings_name: "Renamed issuer",
          billing_party_name: "Renamed recipient",
          billing_party_account_name: "Refund account",
        },
      ],
    },
  );
  if (!result.ok) throw result.error;
  const input = germanBillingSnapshotSchema.parse(result.data);
  expect(input.seller.name).toBe("Original issuer");
  expect(input.buyer.name).toBe("Original recipient");
  expect(input.payment.accountName).toBe("Refund account");
});

test("billing mapping does not replace missing setup with plausible example values", async () => {
  const result = await renderDocumentProfileInput(
    { renderer: billingDocumentRenderer },
    { rows: [mappedRow({ ...row, kind: ["invoice"], settings_iban: null })] },
  );
  expect(result.ok && germanBillingSnapshotSchema.safeParse(result.data).success).toBe(false);
});
