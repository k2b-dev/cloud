import { describe, expect, test } from "bun:test";
import { createGermanBillingProfile, germanBillingSnapshotSchema } from "../document-profiles/einvoice-de";
import { OBJECT_LIST_LIMITS, ObjectListConfigSchema, validateObjectList } from "../field-types/object-list";
import { evaluate } from "../formula/evaluator";
import { parseFormula } from "../formula/parser";
import { billingLineConfig } from "./billing-lines";

const sum = (expression: string, rows: unknown) => {
  const parsed = parseFormula(expression);
  if (!parsed.ok) throw new Error(parsed.error);
  return String(
    evaluate(parsed.ast, {
      fields: { Positions: rows },
      listColumns: { Positions: { net001: "Net001", net007: "Net007", net019: "Net019" } },
    }),
  );
};

describe("billing positions", () => {
  test("row count and persisted byte budget are independent limits", () => {
    const config = billingLineConfig();
    const row = { Label1: "Item", Unit01: ["C62"], Qty001: "1", Price1: "1", Vat001: ["vat019"] };
    const compact = validateObjectList(
      Array.from({ length: config.maxItems }, () => ({ ...row })),
      config,
      true,
    );
    expect(compact.ok).toBe(true);
    if (!compact.ok) throw new Error(compact.error);
    expect(new TextEncoder().encode(JSON.stringify(compact.value)).byteLength).toBeLessThan(OBJECT_LIST_LIMITS.bytes);
    expect(
      validateObjectList(
        Array.from({ length: 100 }, () => ({ ...row, Detail: "x".repeat(4_000) })),
        config,
        true,
      ).ok,
    ).toBe(false);
  });

  for (const locale of ["en", "de"]) {
    test(`${locale} validates rates and exact inputs without trusting supplied totals`, () => {
      const config = billingLineConfig(locale);
      expect(ObjectListConfigSchema.safeParse(config).success).toBe(true);
      const line = { Label1: "Service", Unit01: ["C62"], Qty001: "1.25", Price1: "19.995", Vat001: ["vat019"] };
      expect(validateObjectList([line], config, true)).toMatchObject({
        ok: true,
        value: [{ Net001: "24.99", Net007: "0.00", Net019: "24.99" }],
      });
      for (const change of [
        { Unit01: ["C62"], Qty001: "0" },
        { Unit01: ["C62"], Qty001: "-1" },
        { Price1: "-0.01" },
        { Price1: "1.00001" },
        { Vat001: [] },
        { Vat001: ["vat000"] },
        { Vat001: ["vat007", "vat019"] },
        { Net001: "1" },
      ])
        expect(validateObjectList([{ ...line, ...change }], config, true).ok).toBe(false);
      expect(validateObjectList([], config, true).ok).toBe(false);
    });
  }

  for (const [name, lines] of [
    [
      "group rounding rather than tax per line",
      [
        { Label1: "Small A", Unit01: ["C62"], Qty001: "1", Price1: "0.03", Vat001: ["vat019"] },
        { Label1: "Small B", Unit01: ["C62"], Qty001: "1", Price1: "0.03", Vat001: ["vat019"] },
      ],
    ],
    [
      "mixed rates and fractional quantities",
      [
        { Label1: "Service", Unit01: ["C62"], Qty001: "1.25", Price1: "19.995", Vat001: ["vat019"] },
        { Label1: "Item", Unit01: ["C62"], Qty001: "3", Price1: "0.005", Vat001: ["vat007"] },
        { Label1: "Another item", Unit01: ["C62"], Qty001: "1", Price1: "0.005", Vat001: ["vat007"] },
      ],
    ],
  ] as const) {
    test(`${name}: persisted position calculations match the renderer's XML and totals`, async () => {
      const validated = validateObjectList(lines, billingLineConfig(), true);
      expect(validated.ok).toBe(true);
      if (!validated.ok) throw new Error(validated.error);
      const net = sum("LIST_SUM(Positions, 'Net001')", validated.value);
      const tax = sum("ROUND(LIST_SUM(Positions, 'Net007') * 0.07, 2) + ROUND(LIST_SUM(Positions, 'Net019') * 0.19, 2)", validated.value);
      const gross = sum(
        "LIST_SUM(Positions, 'Net001') + ROUND(LIST_SUM(Positions, 'Net007') * 0.07, 2) + ROUND(LIST_SUM(Positions, 'Net019') * 0.19, 2)",
        validated.value,
      );
      const snapshot = germanBillingSnapshotSchema.parse({
        invoiceDate: "2026-09-14",
        serviceDate: "2026-09-01",
        dueDate: "2026-09-28",
        currency: "EUR",
        billing: { kind: "invoice" },
        seller: {
          name: "Test Seller GmbH",
          vatId: "DE123456789",
          address: { line1: "Test 1", city: "Ulm", postalCode: "89073", countryCode: "DE" },
        },
        buyer: {
          name: "Test Buyer GmbH",
          vatId: "DE987654321",
          address: { line1: "Test 2", city: "Berlin", postalCode: "10115", countryCode: "DE" },
        },
        buyerReference: "TEST",
        payment: { iban: "DE89370400440532013000", accountName: "Test Seller GmbH" },
        lines: validated.value?.map((line) => ({
          name: line.Label1,
          quantity: line.Qty001,
          unitPrice: line.Price1,
          taxRate: Array.isArray(line.Vat001) && line.Vat001[0] === "vat007" ? "7.00" : "19.00",
        })),
      });
      let xml = "";
      const profile = createGermanBillingProfile({
        render: async (value) => {
          xml = value.xml;
          return { pdf: new TextEncoder().encode("%PDF-1.7 test") };
        },
      });
      const rendered = await profile.issue(snapshot, { number: "TEST-1", issuedAt: new Date("2026-09-14T12:00:00Z") });
      const fixed = (value: string) => {
        const [whole, fraction = ""] = value.split(".");
        return `${whole}.${fraction.padEnd(2, "0")}`;
      };
      expect(rendered.output?.netAmount).toBe(fixed(net));
      expect(rendered.output?.taxAmount).toBe(fixed(tax));
      expect(rendered.output?.grossAmount).toBe(fixed(gross));
      expect(rendered.validationStatus).toBe("unchecked");
      expect(xml).toContain(`<ram:GrandTotalAmount>${rendered.output?.grossAmount}</ram:GrandTotalAmount>`);
      if (name.startsWith("group")) expect(rendered.output?.taxAmount).toBe("0.01");
    });
  }
});
