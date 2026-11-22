import { expect, test } from "bun:test";
import { invoice as sample } from "../../examples/einvoice";
import { einvoice, type Invoice } from "./index";
import { validateInvoiceXml } from "./validate";
import { unwrap } from "../result";
import { money } from "../money";

const format = "zugferd-2.5-en16931";
const line = (unitPrice: string, taxRate = "19", id = "1") => ({ ...sample.lines[0]!, id, quantity: "1", unitPrice, taxRate });
const cases = [
  { name: "19% three cents", lines: [line("0.03")], net: "0.03", tax: "0.01", gross: "0.04", rounding: "-0.01", due: "0.03" },
  { name: "19% 99.99", lines: [line("84.03")], net: "84.03", tax: "15.97", gross: "100.00", rounding: "-0.01", due: "99.99" },
  { name: "19% two lines", lines: [line("44.03"), line("49.04", "19", "2")], net: "93.07", tax: "17.68", gross: "110.75", rounding: "0.00", due: "110.75" },
  { name: "7% eight cents", lines: [line("0.07", "7")], net: "0.07", tax: "0.00", gross: "0.07", rounding: "0.01", due: "0.08" },
  { name: "20% tax-first net basis", lines: [line("0.02", "20")], net: "0.02", tax: "0.00", gross: "0.02", rounding: "0.01", due: "0.03" },
  { name: "20% net-first net basis", lines: [line("0.03", "20")], net: "0.03", tax: "0.01", gross: "0.04", rounding: "-0.01", due: "0.03" },
  { name: "mixed 7/19/20", lines: [line("84.03"), line("93.45", "7", "2"), line("0.02", "20", "3")], net: "177.50", tax: "22.51", gross: "200.01", rounding: "0.00", due: "200.01" },
];

for (const kind of ["invoice", "creditNote", "selfBilling", "selfBillingCreditNote"] as const) {
  for (const c of cases) test(`${kind}: explicit rounding ${c.name}`, async () => {
    const plain = unwrap(einvoice.calculate(c.lines));
    const { lines, ...totals } = unwrap(einvoice.calculate(c.lines, { roundingAmount: c.rounding }));
    expect(totals).toMatchObject({ netAmount: c.net, taxAmount: c.tax, grossAmount: c.gross, roundingAmount: c.rounding, dueAmount: c.due });
    expect(totals.taxGroups).toEqual(plain.taxGroups);
    const invoice: Invoice = { ...sample, kind, lines, totals, precedingInvoice: { number: "ORIGINAL", invoiceDate: "2026-08-01" } };
    expect(einvoice.validate(invoice).ok).toBe(true);
    const xml = unwrap(einvoice.serialize(invoice, { format })).xml;
    expect(await validateInvoiceXml(xml, { format })).toEqual({ ok: true, data: undefined });
    const parsed = unwrap(einvoice.parseXml(xml)).invoice;
    expect(parsed).toMatchObject(invoice);
    expect(einvoice.validate(parsed).ok).toBe(true);
    expect(unwrap(einvoice.serialize(parsed, { format })).xml).toBe(xml);
    // Credit kinds use positive document amounts, reversing their economic effect.
    expect(parsed.precedingInvoice).toEqual(invoice.precedingInvoice);
  });
}

test("omitted rounding preserves the old object shape and XML; explicit zero survives", () => {
  const plain = unwrap(einvoice.calculate(sample.lines));
  expect(plain).not.toHaveProperty("roundingAmount");
  expect(unwrap(einvoice.calculate(sample.lines, {}))).toEqual(plain);
  const before = unwrap(einvoice.serialize(sample, { format })).xml;
  expect(before).not.toContain("RoundingAmount");
  const { lines, ...totals } = unwrap(einvoice.calculate(sample.lines, { roundingAmount: "0.00" }));
  const after = unwrap(einvoice.serialize({ ...sample, lines, totals }, { format })).xml;
  expect(after.replace("<ram:RoundingAmount>0.00</ram:RoundingAmount>", "")).toBe(before);
  expect(unwrap(einvoice.parseXml(after)).invoice.totals?.roundingAmount).toBe("0.00");
});

test("malformed rounding and unknown options return errors without throwing", () => {
  for (const roundingAmount of ["-0.00", "+0.01", "01.00", "0.001", "0.1", "1e-2", "NaN", " 0.01", "-" + "9".repeat(409) + ".00"]) {
    expect(einvoice.calculate(sample.lines, { roundingAmount }).ok).toBe(false);
    const { lines, ...totals } = unwrap(einvoice.calculate(sample.lines));
    expect(einvoice.validate({ ...sample, lines, totals: { ...totals, roundingAmount } }).ok).toBe(false);
  }
  // @ts-expect-error runtime boundary must also reject a non-string amount
  expect(einvoice.calculate(sample.lines, { roundingAmount: 0.01 }).ok).toBe(false);
  // @ts-expect-error runtime boundary must reject null options
  expect(einvoice.calculate(sample.lines, null).ok).toBe(false);
  // @ts-expect-error options are strict
  expect(einvoice.calculate(sample.lines, { extra: true }).ok).toBe(false);
});

test("rounding cannot hide inconsistent due, tax, group or gross amounts", () => {
  const { lines, ...totals } = unwrap(einvoice.calculate([line("84.03")], { roundingAmount: "-0.01" }));
  const valid = { ...sample, lines, totals };
  for (const bad of [
    { ...totals, dueAmount: "100.00" }, { ...totals, grossAmount: "99.99" },
    { ...totals, taxAmount: "15.96" }, { ...totals, taxGroups: totals.taxGroups.map(g => ({ ...g, taxAmount: "15.96" })) },
    { ...totals, roundingAmount: undefined },
  ]) {
    expect(einvoice.validate({ ...valid, totals: bad }).ok).toBe(false);
    expect(einvoice.serialize({ ...valid, totals: bad }, { format }).ok).toBe(false);
  }
  const source = unwrap(einvoice.serialize(valid, { format })).xml;
  const inconsistent = source.replace("<ram:DuePayableAmount>99.99", "<ram:DuePayableAmount>100.00");
  const parsed = unwrap(einvoice.parseXml(inconsistent)).invoice;
  expect(parsed.totals?.roundingAmount).toBe("-0.01");
  expect(einvoice.validate(parsed).ok).toBe(false);
  expect(einvoice.serialize(parsed, { format }).ok).toBe(false);
  for (const mutated of [
    source.replace("<ram:RoundingAmount>", '<ram:RoundingAmount currencyID="USD">'),
    source.replace("<ram:RoundingAmount>-0.01</ram:RoundingAmount>", "<ram:RoundingAmount>-0.01</ram:RoundingAmount><ram:RoundingAmount>0.00</ram:RoundingAmount>"),
  ]) expect(einvoice.parseXml(mutated).ok).toBe(false);
});

test("negative due and excessive generated due are rejected, zero due is supported", () => {
  const lines = [line("0.02", "20")];
  expect(einvoice.calculate(lines, { roundingAmount: "-0.03" }).ok).toBe(false);
  expect(unwrap(einvoice.calculate(lines, { roundingAmount: "-0.02" })).dueAmount).toBe("0.00");
  const { lines: calculated, ...totals } = unwrap(einvoice.calculate(lines, { roundingAmount: "9999999999.99" }));
  expect(totals.dueAmount).toBe("10000000000.01");
  expect(einvoice.validate({ ...sample, lines: calculated, totals }).ok).toBe(false);
  const negative = einvoice.validate({ ...sample, lines, totals: { ...totals, roundingAmount: "-0.03", dueAmount: "0.00" } });
  expect(negative.ok).toBe(false);
  if (!negative.ok) expect(negative.error.issues[0]?.path).toEqual(["totals", "roundingAmount"]);
  // Signed invoice lines remain outside the strict writer, also for corrections.
  expect(einvoice.calculate([line("-0.02", "20")]).ok).toBe(false);
});


test("the existing money gross split stays net-first for positive and negative half cents", () => {
  for (const amount of [3, -3]) {
    const gross = money.fromMinor(amount, "EUR");
    const split = money.taxFromGross(gross, { percent: "20", rounding: "half-up" });
    expect(split).toEqual({ gross, net: gross, tax: money.fromMinor(0, "EUR") });
  }
});
