import { describe, expect, mock, test } from "bun:test";
import { renderFacturXHtmlToPdfWithConfig } from "@k2b/cloud/services/pdf";
import { unwrap } from "@k2b/stdlib";
import { einvoice } from "@k2b/stdlib/finance";
import { validateInvoiceXml } from "@k2b/stdlib/finance/validate";
import { PDFDocument } from "pdf-lib";
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

// Explicit opt-in: exercises the external renderer, not a successful mock.
// No DB writes, no bank calls, no production URL inferred from settings.
const livePdfTest = process.env.GRIDS_GOTENBERG_TEST_URL ? test : test.skip;
livePdfTest(
  "real Gotenberg produces readable PDF/XML for invoices, corrections and self-billing",
  async () => {
    const url = new URL(process.env.GRIDS_GOTENBERG_TEST_URL!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Local renderer test only");
    const config = { url: url.toString(), timeoutMs: 30_000, maxHtmlBytes: 5 * 1024 * 1024, maxPdfBytes: 20 * 1024 * 1024 };
    for (const billing of [
      { kind: "invoice" },
      { kind: "creditNote", original: { number: "RE-ORIGINAL", invoiceDate: "2026-08-01" }, reason: "Partial correction" },
      { kind: "selfBilling", agreementReference: "AGREEMENT-42" },
    ] as const) {
      const input = germanBillingSnapshotSchema.parse({ ...snapshot, billing, serviceDate: snapshot.invoiceDate });
      let renderMs = 0;
      const profile = createGermanBillingProfile({
        render: async (value) => {
          const start = performance.now();
          const result = await renderFacturXHtmlToPdfWithConfig(value, config);
          renderMs = performance.now() - start;
          return result;
        },
      });
      const start = performance.now();
      const issued = await profile.issue(input, context);
      const totalMs = performance.now() - start;
      await verifyOutput(issued.artifacts);
      expect(issued.validationStatus).toBe("unchecked");
      expect(issued.validationReport).toMatchObject({ xsd: "not_checked", embeddedXml: "not_checked" });
      expect(issued.output).toMatchObject({ netAmount: "120.00", grossAmount: "140.40" });
      const pdf = issued.artifacts.find((artifact) => artifact.key === "pdf")!;
      expect(new TextDecoder().decode(pdf.bytes.subarray(0, 5))).toBe("%PDF-");
      expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBeGreaterThan(0);
      console.log(
        `E-Invoice ${billing.kind}: total ${totalMs.toFixed(0)} ms; Gotenberg ${renderMs.toFixed(0)} ms; serialization and HTML ${(totalMs - renderMs).toFixed(0)} ms`,
      );
    }
  },
  90_000,
);

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
      });
      expect(profile.version).toBe(2);
      const issued = await profile.issue(input, context);
      expect(issued.validationStatus).toBe("unchecked");
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
      expect((await validateInvoiceXml(xml, { format: "zugferd-2.5-en16931" })).ok).toBe(true);
      expect(xml).toContain(`<ram:TypeCode>${code}</ram:TypeCode>`);
      expect(xml).toContain("20260815");
      expect(xml).toContain("<ram:GrandTotalAmount>140.40</ram:GrandTotalAmount>");
      expect(html).toContain(`<h1>${title} ${context.number}</h1>`);
      expect(html).toContain("140,40 EUR");
      // Keep totals and payment details together when the positions span pages.
      expect(html).toContain(".settlement{break-inside:avoid}");
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

  test("localizes human amounts and dates without rounding fractional prices or changing machine values", async () => {
    const input = germanBillingSnapshotSchema.parse({
      ...snapshot,
      serviceDate: "2026-08-15",
      billing: { kind: "invoice" },
      lines: [
        { name: "Fractional service", quantity: "1.2500", unitPrice: "1234.5678", unitCode: "HUR", taxRate: "19.00" },
        { name: "Whole unit", quantity: "1.0000", unitPrice: "10.0000", unitCode: "C62", taxRate: "7.00" },
      ],
    });
    const original = structuredClone(input);
    let html = "";
    let xml = "";
    const profile = createGermanBillingProfile({
      render: async (value) => {
        html = value.html;
        xml = value.xml;
        return { pdf: new TextEncoder().encode("%PDF-1.7 fixture") };
      },
    });
    const issued = await profile.issue(input, context);
    expect(input).toEqual(original);
    expect(html).toContain("1,25 Std.");
    expect(html).toContain("1 Stk.");
    expect(html).toContain("1.234,5678 EUR");
    expect(html).toContain("10 EUR");
    expect(html).toContain("19 %");
    expect(html).toContain("7 %");
    expect(html).toContain("1.543,21 EUR");
    expect(html).toContain("15.08.2026");
    expect(html).toContain("22.08.2026");
    expect(html).toContain("05.09.2026");
    expect(xml).toContain('<ram:BilledQuantity unitCode="HUR">1.2500</ram:BilledQuantity>');
    expect(xml).toContain("<ram:ChargeAmount>1234.5678</ram:ChargeAmount>");
    expect(xml).toContain("<ram:LineTotalAmount>1543.21</ram:LineTotalAmount>");
    expect(xml).toContain("20260815");
    expect(issued.output?.netAmount).toBe("1553.21");
    expect(new TextDecoder().decode(issued.artifacts.find((artifact) => artifact.key === "structured")!.bytes)).toBe(xml);
  });

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
    });
    await expect(profile.issue(snapshot, context)).resolves.toMatchObject({ validationStatus: "unchecked" });
    expect((await validateInvoiceXml(xml, { format: "zugferd-2.5-en16931" })).ok).toBe(true);
    expect(xml).toContain("<ram:LineTotalAmount>100.00</ram:LineTotalAmount>");
    expect(xml).toContain('<ram:TaxTotalAmount currencyID="EUR">20.40</ram:TaxTotalAmount>');
    expect(xml).toContain("<ram:GrandTotalAmount>140.40</ram:GrandTotalAmount>");
    const rounded = buildGermanEInvoiceXml(
      { ...snapshot, lines: [{ name: "Half cent", quantity: "1.0000", unitPrice: "0.0050", taxRate: "19.00" }] },
      context,
    );
    expect(rounded).toContain("<ram:LineTotalAmount>0.01</ram:LineTotalAmount>");
  });

  test("renders PDF and XML from the same frozen model without claiming output validation", async () => {
    let receivedXml = "";
    const profile = createGermanEInvoiceProfile({
      render: async (input) => {
        receivedXml = input.xml;
        return { pdf: new TextEncoder().encode("%PDF-1.7 fixture") };
      },
    });
    const result = await profile.issue(snapshot, context);
    expect(new TextDecoder().decode(result.artifacts[1]?.bytes)).toBe(receivedXml);
    expect(result.validationReport).toMatchObject({
      inputRules: "valid",
      xsd: "not_checked",
      embeddedXml: "not_checked",
      standard: "EN 16931",
    });
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
    });
    await profile.issue(input, context);
    expect(xml.match(/<ram:LineTotalAmount>1.01<\/ram:LineTotalAmount>/g)).toHaveLength(3);
    expect(xml).toContain("<ram:LineTotalAmount>3.03</ram:LineTotalAmount>");
    expect(xml).toContain("<ram:GrandTotalAmount>3.61</ram:GrandTotalAmount>");
    expect(xml).toContain("<ram:ChargeAmount>1.0050</ram:ChargeAmount>");
    expect(html.match(/<td>1,01 EUR<\/td>/g)).toHaveLength(3);
    expect(html).toContain("3,61 EUR");
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

  test("renders once and propagates renderer failures", async () => {
    const render = mock(async () => {
      throw new Error("renderer unavailable");
    });
    await expect(createGermanEInvoiceProfile({ render }).issue(snapshot, context)).rejects.toThrow("renderer unavailable");
    expect(render).toHaveBeenCalledTimes(1);
  });
});

test("release verification checks a real PDF attachment through the stdlib reader", async () => {
  const profile = createGermanEInvoiceProfile({
    render: async ({ xml }) => {
      const pdf = await PDFDocument.create();
      pdf.addPage();
      await pdf.attach(new TextEncoder().encode(xml), "factur-x.xml", { mimeType: "application/xml" });
      return { pdf: await pdf.save() };
    },
  });
  const result = await profile.issue(snapshot, context);
  expect(result.validationStatus).toBe("unchecked");
  await verifyOutput(result.artifacts);
  expect(result.output?.grossAmount).toBe("140.40");
  expect(result.validationReport).toMatchObject({ xsd: "not_checked", embeddedXml: "not_checked" });
});

// Release checks deliberately live outside issuance. They validate what the
// renderer actually returned, including its attachment, rather than a mock claim.
async function verifyOutput(artifacts: { key: string; bytes: Uint8Array }[]) {
  const pdf = artifacts.find((artifact) => artifact.key === "pdf")!;
  const xml = new TextDecoder().decode(artifacts.find((artifact) => artifact.key === "structured")!.bytes);
  expect((await validateInvoiceXml(xml, { format: "zugferd-2.5-en16931" })).ok).toBe(true);
  const embedded = unwrap(await einvoice.parsePdf(pdf.bytes));
  expect(embedded.filename.toLowerCase()).toBe("factur-x.xml");
  const normalized = (value: string) => value.trim().replace(/encoding="utf-8"/i, 'encoding="UTF-8"');
  expect(normalized(embedded.xml)).toBe(normalized(xml));
}

test("release verification rejects a mismatched PDF attachment", async () => {
  const profile = createGermanEInvoiceProfile({
    render: async () => {
      const pdf = await PDFDocument.create();
      pdf.addPage();
      await pdf.attach(
        new TextEncoder().encode(buildGermanEInvoiceXml(snapshot, { ...context, number: "WRONG-INVOICE" })),
        "factur-x.xml",
        { mimeType: "application/xml" },
      );
      return { pdf: await pdf.save() };
    },
  });
  const issued = await profile.issue(snapshot, context);
  expect(issued.validationStatus).toBe("unchecked");
  await expect(verifyOutput(issued.artifacts)).rejects.toThrow();
});
