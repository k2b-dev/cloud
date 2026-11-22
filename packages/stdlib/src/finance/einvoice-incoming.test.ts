import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { invoice as sample } from "../../examples/einvoice";
import { einvoice, type IncomingInvoiceParseOptions, type Invoice, type InvoiceParseOptions, type ParsedIncomingInvoice, type ParsedInvoice } from "./index";
import { unwrap } from "../result";
import { validateInvoiceXml } from "./validate";

const format = "zugferd-2.5-en16931";
const xml = (invoice: Invoice = sample) => unwrap(einvoice.serialize(invoice, { format })).xml;
const parse = (source: string) => einvoice.parseXml(source, { mode: "incoming" });
const remove = (source: string, tag: string) => source.replace(new RegExp(`<ram:${tag}[^>]*>[\\s\\S]*?</ram:${tag}>`, "g"), "");

test("incoming mode is additive, keeps declared arithmetic, and cannot be silently serialized", () => {
  const original: ParsedInvoice = unwrap(einvoice.parseXml(xml()));
  const source = xml().replace("<ram:GrandTotalAmount>140.40", "<ram:GrandTotalAmount>999.00");
  const incoming: ParsedIncomingInvoice = unwrap(parse(source));
  expect(original.invoice.kind).toBe("invoice");
  expect(incoming.format).toBe("cii-en16931");
  expect(incoming.invoice.totals.grossAmount).toBe("999.00");
  expect(incoming.xml).toBe(source);
  expect(incoming.unmapped).toEqual([]);
  expect(einvoice.validate(incoming.invoice).ok).toBe(false);
  // A dynamic options union must not incorrectly resolve to the old Invoice result type.
  const dynamic = (options: InvoiceParseOptions | IncomingInvoiceParseOptions) => einvoice.parseXml(source, options);
  expect(unwrap(dynamic({ mode: "incoming" })).format).toBe("cii-en16931");
});

test("missing optional dates, references and payment means remain absent", () => {
  let source = xml();
  for (const name of ["ActualDeliverySupplyChainEvent", "SpecifiedTradePaymentTerms", "BuyerReference", "SpecifiedTradeSettlementPaymentMeans"]) source = remove(source, name);
  const invoice = unwrap(parse(source)).invoice;
  expect(invoice.serviceDate).toBeUndefined();
  expect(invoice.paymentTerms).toBeUndefined();
  expect(invoice.buyerReference).toBeUndefined();
  expect(invoice.payments).toEqual([]);
  expect(einvoice.parseXml(source).ok).toBe(false);
});

test("multiple payment means, bank IDs, periods and optional empty text survive", () => {
  const source = xml().replace("</ram:ApplicableHeaderTradeSettlement>", `
    <ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>30</ram:TypeCode><ram:Information>Transfer</ram:Information>
      <ram:PayeePartyCreditorFinancialAccount><ram:ProprietaryID>1234</ram:ProprietaryID></ram:PayeePartyCreditorFinancialAccount>
      <ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>TESTDEFFXXX</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>
    </ram:SpecifiedTradeSettlementPaymentMeans>
    <ram:BillingSpecifiedPeriod><ram:StartDateTime><udt:DateTimeString format="102">20260101</udt:DateTimeString></ram:StartDateTime><ram:EndDateTime><udt:DateTimeString format="102">20260131</udt:DateTimeString></ram:EndDateTime></ram:BillingSpecifiedPeriod>
    </ram:ApplicableHeaderTradeSettlement>`).replace("</ram:SpecifiedTradeProduct>", "<ram:Description></ram:Description></ram:SpecifiedTradeProduct>");
  const invoice = unwrap(parse(source)).invoice;
  expect(invoice.payments).toHaveLength(2);
  expect(invoice.payments[1]).toMatchObject({ typeCode: "30", information: "Transfer", creditorAccount: { id: "1234" }, creditorBic: "TESTDEFFXXX" });
  expect(invoice.period).toEqual({ startDate: "2026-01-01", endDate: "2026-01-31" });
  expect(invoice.lines[0]?.description).toBe("");
});

test("arbitrary precision signed XML decimals and price base without optional unit are preserved", () => {
  const source = xml().replace("</ram:NetPriceProductTradePrice>", "<ram:BasisQuantity>100.</ram:BasisQuantity></ram:NetPriceProductTradePrice>")
    .replace(/(<ram:ChargeAmount>)[^<]+/, "$1+09007199254740993.005000")
    .replace(/(<ram:BilledQuantity[^>]*>)[^<]+/, "$1-.5000")
    .replace(/(<ram:LineTotalAmount>)[^<]+/, "$1-45035996273704.96502500");
  const line = unwrap(parse(source)).invoice.lines[0]!;
  expect(line.unitPrice).toBe("+09007199254740993.005000");
  expect(line.quantity).toBe("-.5000");
  expect(line.netAmount).toBe("-45035996273704.96502500");
  expect(line.priceBasis).toEqual({ quantity: "100.", unitCode: undefined });
});

test("VAT accounting currency is selected by currency ID, never XML order", () => {
  const source = xml().replace("<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>", "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode><ram:TaxCurrencyCode>USD</ram:TaxCurrencyCode>")
    .replace('<ram:TaxTotalAmount currencyID="EUR">', '<ram:TaxTotalAmount currencyID="USD">22.001</ram:TaxTotalAmount><ram:TaxTotalAmount currencyID="EUR">');
  const invoice = unwrap(parse(source)).invoice;
  expect(invoice.taxCurrency).toBe("USD");
  expect(invoice.totals.taxAmount).toBe("20.40");
  expect(invoice.totals.taxAccountingAmount).toBe("22.001");
});

test("unmapped elements and attributes retain namespace, value and unambiguous paths", () => {
  const source = xml().replace("<ram:Name>Consulting</ram:Name>", '<ram:Name custom="keep">Consulting</ram:Name><x:Extra xmlns:x="urn:test"><x:Value>one</x:Value><x:Value>two</x:Value></x:Extra>');
  const parsed = unwrap(parse(source));
  expect(parsed.xml).toBe(source);
  expect(parsed.unmapped).toHaveLength(2);
  expect(parsed.unmapped[0]).toMatchObject({ kind: "attribute", name: "custom", value: "keep", namespace: "" });
  const entry = parsed.unmapped[1]!;
  expect(entry.path).toContain("IncludedSupplyChainTradeLineItem[1]");
  expect(entry.path).toContain("Q{urn:test}Extra[1]");
  if (entry.kind !== "element") throw new Error("Expected unmapped element");
  expect(entry.element.children.map(child => child.text)).toEqual(["one", "two"]);
});

for (const profile of ["urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0", "urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3"]) {
  test(`explicit CII profile: ${profile}`, async () => {
    const source = xml().replace("urn:cen.eu:en16931:2017", profile);
    expect(unwrap(parse(source)).profile).toBe(profile);
    expect(einvoice.parseXml(source).ok).toBe(false);
    expect(await validateInvoiceXml(source, { format, mode: "incoming" })).toEqual({ ok: true, data: undefined });
    expect((await validateInvoiceXml(source, { format })).ok).toBe(false);
  });
}

const invalidMutations: [string, (source: string) => string][] = [
  ["duplicate amount", source => source.replace("<ram:GrandTotalAmount>", "<ram:GrandTotalAmount>0</ram:GrandTotalAmount><ram:GrandTotalAmount>")],
  ["duplicate tax total", source => source.replace('<ram:TaxTotalAmount currencyID="EUR">', '<ram:TaxTotalAmount currencyID="EUR">0</ram:TaxTotalAmount><ram:TaxTotalAmount currencyID="EUR">')],
  ["wrong tax currency", source => source.replace('currencyID="EUR"', 'currencyID="USD"')],
  ["duplicate line ID", source => source.replace("<ram:LineID>2", "<ram:LineID>1")],
  ["missing line tax group", source => source.replace("<ram:RateApplicablePercent>19", "<ram:RateApplicablePercent>18")],
  ["zero standard rate", source => source.replace("<ram:RateApplicablePercent>19", "<ram:RateApplicablePercent>0")],
  ["wrong element namespace", source => source.replace("<ram:GrandTotalAmount>", '<ram:GrandTotalAmount xmlns:ram="urn:attacker">')],
  ["shadowed amount", source => source.replace("</ram:GrandTotalAmount>", '</ram:GrandTotalAmount><evil:GrandTotalAmount xmlns:evil="urn:attacker">0</evil:GrandTotalAmount>')],
  ["mixed scalar content", source => source.replace("<ram:GrandTotalAmount>", "<ram:GrandTotalAmount><ram:Name>0</ram:Name>")],
  ["mixed container content", source => source.replace("<ram:SpecifiedTradeProduct>", "<ram:SpecifiedTradeProduct>hidden")],
  ["wrong attribute namespace", source => source.replace('currencyID="EUR"', 'xmlns:x="urn:attacker" x:currencyID="EUR"')],
  ["invalid calendar date", source => source.replace(/(<udt:DateTimeString format="102">)\d+/, "$120260230")],
  ["year zero", source => source.replace(/(<udt:DateTimeString format="102">)\d+/, "$100000101")],
  ["zero price basis", source => source.replace("</ram:NetPriceProductTradePrice>", "<ram:BasisQuantity>0.00</ram:BasisQuantity></ram:NetPriceProductTradePrice>")],
  ["different price unit", source => source.replace("</ram:NetPriceProductTradePrice>", '<ram:BasisQuantity unitCode="ZZ">100</ram:BasisQuantity></ram:NetPriceProductTradePrice>')],
  ["unknown profile", source => source.replace("urn:cen.eu:en16931:2017", "urn:cen.eu:en16931:2017#compliant#unknown")],
  ["DTD", source => source.replace("<rsm:CrossIndustryInvoice", '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rsm:CrossIndustryInvoice')],
  ["undeclared entity", source => source.replace("Consulting", "&secret;")],
  ["truncated document", source => source.slice(0, -20)],
];
for (const value of ["NaN", "Infinity", "1e9", "0xFF", "--1", "1,00", "", "."]) invalidMutations.push([`decimal ${value}`, source => source.replace(/(<ram:GrandTotalAmount>)[^<]+/, `$1${value}`)]);
for (const [name, mutate] of invalidMutations) test(`incoming rejects ${name}`, () => {
  const result = parse(mutate(xml()));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.issues[0]?.path[0]).toBe("xml");
});

test("limits apply equally to incoming XML, XSD and PDF", async () => {
  const source = xml();
  for (const limits of [{ maxCharacters: 1 }, { maxDepth: 1 }, { maxElements: 1 }, { maxCharacters: NaN }, { maxDepth: -1 }]) {
    expect(einvoice.parseXml(source, { mode: "incoming", ...limits }).ok).toBe(false);
    expect((await validateInvoiceXml(source, { format, mode: "incoming", ...limits })).ok).toBe(false);
  }
  const pdf = await PDFDocument.create(); pdf.addPage();
  const incomingSource = remove(source, "ActualDeliverySupplyChainEvent");
  await pdf.attach(new TextEncoder().encode(incomingSource), "factur-x.xml");
  const bytes = await pdf.save();
  const parsed = unwrap(await einvoice.parsePdf(bytes, { mode: "incoming" }));
  expect(parsed.filename).toBe("factur-x.xml");
  expect(parsed.invoice.serviceDate).toBeUndefined();
  expect(parsed.xml).toBe(incomingSource);
  expect((await einvoice.parsePdf(bytes)).ok).toBe(true);
  expect((await einvoice.parsePdf(bytes, { mode: "incoming", maxCharacters: 1 })).ok).toBe(false);
  expect((await einvoice.parsePdf(bytes, { mode: "incoming", maxPdfBytes: 1 })).ok).toBe(false);
});

for (const category of ["E", "AE", "K", "G", "O", "Z"] as const) test(`incoming ${category} reasons and identity rules`, () => {
  const input: Invoice = { ...sample, seller: { ...sample.seller, ...(category === "O" ? { vatId: "", id: "seller" } : {}) },
    buyer: { ...sample.buyer, ...(category === "O" ? { vatId: "" } : {}) }, deliverToCountryCode: "FR",
    lines: [{ ...sample.lines[0]!, taxCategory: category, taxRate: "0", ...(category === "Z" ? {} : { taxExemptionReason: "Reason" }) }] };
  const source = xml(input), invoice = unwrap(parse(source)).invoice;
  expect(invoice.lines[0]?.taxCategory).toBe(category);
  expect(invoice.lines[0]?.taxExemptionReason).toBe(category === "Z" ? undefined : "Reason");
  expect(invoice.lines[0]?.taxRate).toBe(category === "O" ? undefined : "0");
  if (category !== "Z") expect(parse(remove(source, "ExemptionReason")).ok).toBe(false);
  if (category === "AE" || category === "K") {
    const withoutBuyerVat = source.replace(/(<ram:BuyerTradeParty>)[\s\S]*?(<ram:SpecifiedTaxRegistration>[\s\S]*?<\/ram:SpecifiedTaxRegistration>)/, match => remove(match, "SpecifiedTaxRegistration"));
    expect(parse(withoutBuyerVat).ok).toBe(false);
    const legal = withoutBuyerVat.replace("</ram:BuyerTradeParty>", "<ram:SpecifiedLegalOrganization><ram:ID>HRB123</ram:ID></ram:SpecifiedLegalOrganization></ram:BuyerTradeParty>");
    expect(parse(legal).ok).toBe(category === "AE");
  }
});

test("O header rate may be zero while line rates remain absent", () => {
  const input: Invoice = { ...sample, seller: { ...sample.seller, vatId: "", id: "seller" }, buyer: { ...sample.buyer, vatId: "" },
    lines: [{ ...sample.lines[0]!, taxCategory: "O", taxRate: "0", taxExemptionReasonCode: "VATEX-EU-O" }] };
  const source = xml(input).replace("<ram:ExemptionReasonCode>VATEX-EU-O</ram:ExemptionReasonCode>", "<ram:ExemptionReasonCode>VATEX-EU-O</ram:ExemptionReasonCode><ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>");
  const parsed = unwrap(parse(source));
  expect(parsed.invoice.totals.taxGroups[0]?.taxRate).toBe("0.00");
  expect(parsed.invoice.lines[0]?.taxRate).toBeUndefined();
  const lineRate = source.replace("<ram:CategoryCode>O</ram:CategoryCode>", "<ram:CategoryCode>O</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent>");
  expect(parse(lineRate).ok).toBe(false);
});

test("line exemption reasons cannot be overwritten by conflicting group data", () => {
  const source = xml({ ...sample, lines: [{ ...sample.lines[0]!, taxCategory: "E", taxRate: "0", taxExemptionReason: "Reason" }] });
  const conflict = source.replace("<ram:CategoryCode>E</ram:CategoryCode>", "<ram:CategoryCode>E</ram:CategoryCode><ram:ExemptionReason>Different</ram:ExemptionReason>");
  expect(parse(conflict).ok).toBe(false);
});

test("document adjustments retain their sign, tax group and basis", () => {
  const source = xml().replace("</ram:ApplicableHeaderTradeSettlement>", `<ram:SpecifiedTradeAllowanceCharge>
    <ram:ChargeIndicator><udt:Indicator>0</udt:Indicator></ram:ChargeIndicator>
    <ram:CalculationPercent>5.0</ram:CalculationPercent><ram:BasisAmount>100.00</ram:BasisAmount><ram:ActualAmount>5.00</ram:ActualAmount>
    <ram:Reason>Discount</ram:Reason><ram:CategoryTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode><ram:RateApplicablePercent>19.00</ram:RateApplicablePercent></ram:CategoryTradeTax>
    </ram:SpecifiedTradeAllowanceCharge></ram:ApplicableHeaderTradeSettlement>`);
  expect(unwrap(parse(source)).invoice.adjustments[0]).toMatchObject({ charge: false, percent: "5.0", basisAmount: "100.00", amount: "5.00", reason: "Discount", tax: { taxCategory: "S", taxRate: "19.00" } });
  expect(parse(source.replace("<udt:Indicator>0", "<udt:Indicator>maybe")).ok).toBe(false);
  expect(parse(source.replace("<ram:RateApplicablePercent>19.00", "<ram:RateApplicablePercent>18.00")).ok).toBe(false);
});

test("XSD validation survives global provider cleanup and alternating concurrent inputs", async () => {
  const { xmlCleanupInputProvider } = await import("libxml2-wasm");
  const source = xml();
  expect((await validateInvoiceXml(source, { format, mode: "incoming" })).ok).toBe(true);
  xmlCleanupInputProvider(); // Another libxml2 consumer may reset the global registry.
  const invalid = source.replace("<ram:GrandTotalAmount>140.40", "<ram:GrandTotalAmount>NaN");
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) => validateInvoiceXml(index % 2 ? invalid : source, { format, mode: "incoming" })));
  expect(results.map(result => result.ok)).toEqual(Array.from({ length: 100 }, (_, index) => index % 2 === 0));
  expect((await validateInvoiceXml(source, { format })).ok).toBe(true);
});
