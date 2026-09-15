import { describe, expect, test } from "bun:test";
import {
  buildGermanEInvoiceXml,
  createGermanBillingProfile,
  createGermanEInvoiceProfile,
  germanBillingSnapshotSchema,
  germanEInvoiceSnapshotSchema,
} from "./einvoice-de";

const snapshot = {
  invoiceDate: "2026-08-22",
  dueDate: "2026-09-05",
  currency: "EUR" as const,
  seller: {
    name: "Example Seller GmbH",
    vatId: "DE123456789",
    address: { line1: "Hauptstrasse 1", city: "Ulm", postalCode: "89073", countryCode: "DE" as const },
  },
  buyer: {
    name: "Example Buyer GmbH",
    vatId: "DE987654321",
    address: { line1: "Markt 2", city: "Berlin", postalCode: "10115", countryCode: "DE" as const },
  },
  buyerReference: "PUR-42",
  payment: { iban: "DE89370400440532013000", accountName: "Example Seller GmbH" },
  lines: [
    { name: "Consulting", quantity: "2.0000", unitPrice: "50.0000", taxRate: "19.00" },
    { name: "Books", quantity: "1.0000", unitPrice: "20.0000", taxRate: "7.00" },
  ],
};

const context = { number: "RE-2026-000001", issuedAt: new Date("2026-08-22T10:00:00Z") };

describe("German E-Invoice profile", () => {
  for (const [billing, code, title] of [
    [{ kind: "invoice" }, "380", "Rechnung"],
    [
      { kind: "creditNote", original: { number: "RE-ORIGINAL", invoiceDate: "2026-08-01" }, reason: "Teilkorrektur" },
      "381",
      "Rechnungskorrektur",
    ],
    [{ kind: "selfBilling", agreementReference: "AGREEMENT-42" }, "389", "Gutschrift (Selbstabrechnung)"],
  ] as const) {
    test(`version 2 renders ${billing.kind} with matching PDF and schema-valid XML`, async () => {
      const input = germanBillingSnapshotSchema.parse({ ...snapshot, serviceDate: "2026-08-15", billing });
      expect(germanEInvoiceSnapshotSchema.safeParse(input).success).toBe(false);
      let xml = "";
      let html = "";
      const profile = createGermanBillingProfile({
        render: async (value) => {
          xml = value.xml;
          html = value.html;
          return { pdf: new TextEncoder().encode("%PDF-1.7 fixture") };
        },
        extractEmbedded: async () => ({ filename: "factur-x.xml", xml }),
      });
      expect(profile.version).toBe(2);
      const issued = await profile.issue(input, context);
      expect(issued.validationStatus).toBe("valid");
      expect(issued.output).toEqual({
        currency: "EUR",
        netAmount: "120.00",
        taxAmount: "20.40",
        grossAmount: "140.40",
        taxGroups: [
          { taxRate: "19.00", netAmount: "100.00", taxAmount: "19.00" },
          { taxRate: "7.00", netAmount: "20.00", taxAmount: "1.40" },
        ],
      });
      expect(xml).toContain(`<ram:TypeCode>${code}</ram:TypeCode>`);
      expect(xml).toContain("20260815");
      expect(xml).toContain("<ram:GrandTotalAmount>140.40</ram:GrandTotalAmount>");
      expect(html).toContain(`<h1>${title} ${context.number}</h1>`);
      expect(html).toContain("140.40 EUR");
      // Keep totals and payment details together when the positions span pages.
      expect(html).toContain('.settlement{break-inside:avoid}');
      const settlement = html.match(/<tbody class="settlement">([\s\S]*?)<\/tbody>/)?.[1];
      expect(settlement).toContain("Gesamt");
      expect(settlement).toContain(`IBAN: ${input.payment.iban}`);
      expect(xml).toContain("<ram:SellerTradeParty><ram:Name>Example Seller GmbH</ram:Name>");
      if (billing.kind === "creditNote") {
        expect(xml).toContain("<ram:InvoiceReferencedDocument>");
        expect(xml).toContain("RE-ORIGINAL");
        expect(html).toContain("RE-ORIGINAL");
      }
      if (billing.kind === "selfBilling") {
        expect(xml).toContain("AGREEMENT-42");
        expect(html).toContain("AGREEMENT-42");
      }
    });
  }

  test("version 2 rejects ambiguous document kinds, missing references and invalid party roles", () => {
    const input = { ...snapshot, serviceDate: "2026-08-15", billing: { kind: "invoice" } };
    expect(germanBillingSnapshotSchema.safeParse(snapshot).success).toBe(false);
    for (const billing of [
      { kind: "creditNote" },
      { kind: "selfBilling" },
      { kind: "payout" },
      { kind: "creditNote", reason: "Correction", original: { number: "RE-42", invoiceDate: "2026-08-23" } },
      { kind: "invoice", original: { number: "RE-42", invoiceDate: "2026-08-01" } },
    ])
      expect(germanBillingSnapshotSchema.safeParse({ ...input, billing }).success).toBe(false);
    expect(germanBillingSnapshotSchema.safeParse({ ...input, buyer: snapshot.seller }).success).toBe(false);
    expect(germanBillingSnapshotSchema.safeParse({ ...input, lines: [{ ...snapshot.lines[0], quantity: "-1.0000" }] }).success).toBe(false);
  });
  test("describes technical validation without promising tax or legal approval", () => {
    const profile = createGermanEInvoiceProfile();
    expect(profile.description).toContain("Technical validation is not tax or legal approval");
    expect(profile.description).toContain("issuer is responsible");
  });
  test("generates exact-decimal EN 16931 XML accepted by the pinned input rules and XSD", async () => {
    expect(germanEInvoiceSnapshotSchema.safeParse(snapshot).success).toBe(true);
    const xml = buildGermanEInvoiceXml(snapshot, context);
    const profile = createGermanEInvoiceProfile({
      render: async () => ({ pdf: new TextEncoder().encode("%PDF-1.7 fixture") }),
      extractEmbedded: async () => ({ filename: "factur-x.xml", xml }),
    });
    await expect(profile.issue(snapshot, context)).resolves.toMatchObject({ validationStatus: "valid" });
    expect(xml).toContain("<ram:LineTotalAmount>100.00</ram:LineTotalAmount>");
    expect(xml).toContain('<ram:TaxTotalAmount currencyID="EUR">20.40</ram:TaxTotalAmount>');
    expect(xml).toContain("<ram:GrandTotalAmount>140.40</ram:GrandTotalAmount>");
    const rounded = buildGermanEInvoiceXml(
      { ...snapshot, lines: [{ name: "Half cent", quantity: "1.0000", unitPrice: "0.0050", taxRate: "19.00" }] },
      context,
    );
    expect(rounded).toContain("<ram:LineTotalAmount>0.01</ram:LineTotalAmount>");
  });

  test("renders the PDF and XML from the same frozen model and marks only technical validity", async () => {
    let receivedXml = "";
    const profile = createGermanEInvoiceProfile({
      render: async (input) => {
        receivedXml = input.xml;
        return { pdf: new TextEncoder().encode("%PDF-1.7 fixture") };
      },
      extractEmbedded: async () => ({ filename: "factur-x.xml", xml: receivedXml.replace('encoding="UTF-8"', 'encoding="utf-8"') }),
    });
    const result = await profile.issue(snapshot, context);
    expect(new TextDecoder().decode(result.artifacts[1]?.bytes)).toBe(receivedXml);
    expect(result.validationReport).toMatchObject({ inputRules: "valid", xsd: "valid", embeddedXml: "verified", standard: "EN 16931" });
  });

  test("uses the same half-up line totals in XML and PDF, including repeated half cents", async () => {
    const input = {
      ...snapshot,
      lines: Array.from({ length: 3 }, (_, index) => ({
        name: `Line ${index + 1}`,
        quantity: "1.0000",
        unitPrice: "1.0050",
        taxRate: "19.00",
      })),
    };
    let xml = "";
    let html = "";
    const profile = createGermanEInvoiceProfile({
      render: async (value) => {
        xml = value.xml;
        html = value.html;
        return { pdf: new TextEncoder().encode("%PDF-1.7 fixture") };
      },
      extractEmbedded: async () => ({ filename: "factur-x.xml", xml }),
    });
    await profile.issue(input, context);
    expect(xml.match(/<ram:LineTotalAmount>1.01<\/ram:LineTotalAmount>/g)).toHaveLength(3);
    expect(xml).toContain("<ram:LineTotalAmount>3.03</ram:LineTotalAmount>");
    expect(xml).toContain("<ram:GrandTotalAmount>3.61</ram:GrandTotalAmount>");
    expect(html.match(/<td>1.01 EUR<\/td>/g)).toHaveLength(3);
    expect(html).toContain("3.61 EUR");
  });

  test("rejects floating-point amounts and unsupported invoice shapes at the public profile boundary", () => {
    expect(germanEInvoiceSnapshotSchema.safeParse({ ...snapshot, lines: [{ ...snapshot.lines[0], unitPrice: 12.34 }] }).success).toBe(
      false,
    );
    expect(germanEInvoiceSnapshotSchema.safeParse({ ...snapshot, currency: "USD" }).success).toBe(false);
    expect(germanEInvoiceSnapshotSchema.safeParse({ ...snapshot, dueDate: "2026-08-21" }).success).toBe(false);
    expect(germanEInvoiceSnapshotSchema.safeParse({ ...snapshot, invoiceDate: "2026-02-31" }).success).toBe(false);
    expect(
      germanEInvoiceSnapshotSchema.safeParse({ ...snapshot, payment: { ...snapshot.payment, iban: "DE00370400440532013000" } }).success,
    ).toBe(false);
    expect(germanEInvoiceSnapshotSchema.safeParse({ ...snapshot, lines: [{ ...snapshot.lines[0], taxRate: "0.00" }] }).success).toBe(false);
  });

  test("rejects a PDF whose embedded XML is not the generated invoice", async () => {
    const profile = createGermanEInvoiceProfile({
      render: async () => ({ pdf: new TextEncoder().encode("%PDF-1.7 fixture") }),
      extractEmbedded: async () => ({ filename: "factur-x.xml", xml: "<different/>" }),
    });
    await expect(profile.issue(snapshot, context)).rejects.toThrow("does not contain the generated Factur-X XML");
  });
});
