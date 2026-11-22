import { describe, expect, test } from "bun:test";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { invoice as sample } from "../../examples/einvoice";
import { einvoice, type Invoice } from "./index";
import { validateInvoiceXml } from "./validate";
import { unwrap } from "../result";
const format = "zugferd-2.5-en16931";
const xml = (invoice: Invoice = sample) => unwrap(einvoice.serialize(invoice, { format })).xml;

test("addresses with line1 retain the exact 0.31.1 XML bytes", async () => {
  const baseline = await Bun.file(new URL("../../examples/fixtures/einvoice/line1-0.31.1.xml", import.meta.url)).bytes();
  expect(unwrap(einvoice.serialize(sample, { format })).bytes).toEqual(baseline);
});

for (const kind of ["invoice", "creditNote", "selfBilling", "selfBillingCreditNote"] as const) {
  for (const swapped of [false, true]) for (const absent of ["seller", "buyer", "both"]) {
    for (const line1 of [undefined, ""]) {
      test(`${kind}: ${absent} line1 ${line1 === undefined ? "omitted" : "empty"}, swapped=${swapped}`, async () => {
        const input: Invoice = structuredClone({ ...sample, kind,
          seller: swapped ? sample.buyer : sample.seller, buyer: swapped ? sample.seller : sample.buyer,
          precedingInvoice: { number: "ORIGINAL", invoiceDate: "2026-08-01" },
        });
        for (const party of ["seller", "buyer"] as const) if (absent === party || absent === "both") {
          if (line1 === undefined) delete input[party].address.line1;
          else input[party].address.line1 = line1;
        }
        expect(einvoice.validate(input).ok).toBe(true);
        const source = xml(input);
        expect(source.match(/<ram:LineOne>/g) ?? []).toHaveLength(absent === "both" ? 0 : 1);
        expect((await validateInvoiceXml(source, { format })).ok).toBe(true);
        const parsed = unwrap(einvoice.parseXml(source)).invoice;
        for (const party of ["seller", "buyer"] as const) {
          expect(parsed[party].address).toEqual({ ...input[party].address, line1: input[party].address.line1 || undefined });
        }
        expect(xml(parsed)).toBe(source);
        expect(unwrap(await einvoice.parsePdf(await (await pdfWithInvoice(source)).save())).invoice).toEqual(parsed);
      });
    }
  }
}

test("optional line1 keeps XML text limits and other address requirements", () => {
  for (const party of ["seller", "buyer"] as const) {
    for (const line1 of [" ", "bad\0", "bad\ud800", "a".repeat(201), null]) {
      const input = { ...sample, [party]: { ...sample[party], address: { ...sample[party].address, line1 } } };
      expect(einvoice.validate(input).ok).toBe(false);
      expect(einvoice.serialize(input, { format }).ok).toBe(false);
    }
    for (const field of ["countryCode", "postalCode", "city"] as const) {
      const input = structuredClone(sample);
      delete input[party].address.line1;
      const { [field]: omitted, ...address } = input[party].address;
      expect(einvoice.validate({ ...input, [party]: { ...input[party], address } }).ok).toBe(false);
      expect(einvoice.validate({ ...input, [party]: { ...input[party], address: { ...address, [field]: "" } } }).ok).toBe(false);
      const element = { countryCode: "CountryID", postalCode: "PostcodeCode", city: "CityName" }[field];
      expect(einvoice.parseXml(xml(input).replace(new RegExp(`<ram:${element}>[^<]*</ram:${element}>`), "")).ok).toBe(false);
    }
  }
  const source = xml();
  expect(einvoice.parseXml(source.replace("<ram:LineOne>", "<ram:LineOne>duplicate</ram:LineOne><ram:LineOne>")).ok).toBe(false);
  expect(einvoice.parseXml(source.replace(/<ram:LineOne>[^<]*<\/ram:LineOne>/, `<ram:LineOne>${"a".repeat(201)}</ram:LineOne>`)).ok).toBe(false);
});

for (const kind of ["invoice", "creditNote", "selfBilling", "selfBillingCreditNote"] as const) {
  test(`${kind}: generate, validate XSD, parse without losing decimals`, async () => {
    const input: Invoice = { ...sample, kind, notes: ["Terms & conditions <agreed>\r\n✓"], ...((kind === "creditNote" || kind === "selfBillingCreditNote") ? { precedingInvoice: { number: "ORIGINAL", invoiceDate: "2026-08-01" } } : {}) };
    const source = xml(input);
    expect(await validateInvoiceXml(source, { format })).toEqual({ ok: true, data: undefined });
    const parsed = unwrap(einvoice.parseXml(source));
    expect(parsed.xml).toBe(source);
    expect(parsed.invoice).toMatchObject(input);
    expect(parsed.invoice.totals).toMatchObject({ netAmount: "120.00", taxAmount: "20.40", grossAmount: "140.40" });
    expect(xml(parsed.invoice)).toBe(source);
  });
}

test("half-cent unit prices stay exact and agree with rounded line and tax-group totals", () => {
  const input = { ...sample, lines: Array.from({ length: 3 }, (_, index) => ({ ...sample.lines[0]!, id: String(index + 1), quantity: "1.0000", unitPrice: "1.0050" })) };
  const parsed = unwrap(einvoice.parseXml(xml(input))).invoice;
  expect(parsed.lines[0]?.unitPrice).toBe("1.0050");
  expect(parsed.lines.map(line => line.netAmount)).toEqual(["1.01", "1.01", "1.01"]);
  expect(parsed.totals).toMatchObject({ netAmount: "3.03", taxAmount: "0.58", grossAmount: "3.61" });
});

test("amounts beyond Number precision and equivalent VAT rates", () => {
  const first = { ...sample.lines[0]!, quantity: "1", unitPrice: "9007199254740993.0050", taxRate: "19" };
  const totals = unwrap(einvoice.calculate([first, { ...first, id: "2", unitPrice: "0", taxRate: "19.00" }]));
  expect(totals.netAmount).toBe("9007199254740993.01");
  expect(totals.taxGroups).toHaveLength(1);
  expect(einvoice.serialize({ ...sample, lines: [first] }, { format }).ok).toBe(false);
});

test("parsing preserves declared inconsistent sums; generation rejects them", () => {
  const source = xml().replace("<ram:GrandTotalAmount>140.40", "<ram:GrandTotalAmount>999.00");
  const parsed = unwrap(einvoice.parseXml(source));
  expect(parsed.invoice.totals?.grossAmount).toBe("999.00");
  expect(einvoice.serialize(parsed.invoice, { format }).ok).toBe(false);
  expect(einvoice.serialize({ ...sample, lines: [{ ...sample.lines[0]!, netAmount: "1.00" }] }, { format }).ok).toBe(false);
});

test("prefixes, comments, CDATA and UTF-8 BOM do not change namespace semantics", () => {
  const source = '\uFEFF' + xml().replaceAll("ram:", "a:").replace("xmlns:ram=", "xmlns:a=").replace("Consulting", "<![CDATA[Consulting]]>").replace("<rsm:ExchangedDocument>", "<!-- comment --><rsm:ExchangedDocument>");
  expect(unwrap(einvoice.parseXml(source)).invoice.lines[0]?.name).toBe("Consulting");
});

describe("reject unsafe, ambiguous and unsupported input", () => {
  const transforms = [
    (s: string) => s.replace("<ram:Name>Consulting", "<ram:Name>Consulting</ram:Name><ram:Name>Second"),
    (s: string) => s.replace("<ram:InvoiceCurrencyCode>EUR", "<ram:InvoiceCurrencyCode>USD"),
    (s: string) => s.replace("<ram:CategoryCode>S", "<ram:CategoryCode>E"),
    (s: string) => s.replace("<ram:NetPriceProductTradePrice>", "<ram:NetPriceProductTradePrice><ram:BasisQuantity>100</ram:BasisQuantity>"),
    (s: string) => s.replace("<ram:ChargeTotalAmount>0.00", "<ram:ChargeTotalAmount>1.00"),
    (s: string) => s.replace("<ram:Name>Consulting", '<ram:Name xmlns:ram="urn:spoof">Consulting'),
    (s: string) => s.replace("<ram:Name>Consulting", '<ram:Name currencyID="USD">Consulting'),
    (s: string) => s.replace("<rsm:CrossIndustryInvoice", '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><rsm:CrossIndustryInvoice'),
    (s: string) => s.replace("Consulting", "&unknown;"),
    (s: string) => s + "<extra/>",
    (s: string) => s.slice(0, -1),
    (s: string) => s.replace("urn:cen.eu:en16931:2017", "urn:xeinkauf.de:kosit:xrechnung_3.0"),
  ];
  for (const [index, transform] of transforms.entries()) test(`XML case ${index}`, () => expect(einvoice.parseXml(transform(xml())).ok).toBe(false));
  test("limits", () => {
    for (const options of [{ maxCharacters: 1 }, { maxElements: 1 }, { maxDepth: 1 }, { maxDepth: 0 }]) expect(einvoice.parseXml(xml(), options).ok).toBe(false);
  });
  test("input validation", () => {
    for (const input of [null, { ...sample, invoiceDate: "2026-02-31" }, { ...sample, number: "bad\0" }, { ...sample, number: "bad\ud800" }, { ...sample, extra: true }, { ...sample, kind: "creditNote" }, { ...sample, kind: "selfBillingCreditNote" }, { ...sample, lines: [sample.lines[0], sample.lines[0]] }, { ...sample, lines: [{ ...sample.lines[0], unitPrice: 1.5 }] }]) expect(einvoice.validate(input).ok).toBe(false);
  });
});

test("XSD rejection and repeated concurrent validation", async () => {
  expect((await validateInvoiceXml(xml().replace("<ram:GrandTotalAmount>140.40", "<ram:GrandTotalAmount>abc"), { format })).ok).toBe(false);
  const results = await Promise.all(Array.from({ length: 8 }, () => validateInvoiceXml(xml(), { format })));
  expect(results.every(result => result.ok)).toBe(true);
});

async function pdfWithInvoice(source = xml(), filename = "factur-x.xml") {
  const pdf = await PDFDocument.create(); pdf.addPage();
  await pdf.attach(new TextEncoder().encode(source), filename, { mimeType: "application/xml" });
  return pdf;
}

test("real compressed PDF attachment round trip and nested name tree", async () => {
  const pdf = await pdfWithInvoice();
  const bytes = await pdf.save();
  expect(unwrap(await einvoice.parsePdf(bytes)).invoice.number).toBe(sample.number);
  const loaded = await PDFDocument.load(bytes);
  const names = loaded.catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict);
  const child = loaded.context.obj({ Names: names.lookup(PDFName.of("Names"), PDFArray) });
  names.delete(PDFName.of("Names")); names.set(PDFName.of("Kids"), loaded.context.obj([child]));
  expect(unwrap(await einvoice.parsePdf(await loaded.save())).filename).toBe("factur-x.xml");
});

test("PDF rejects absent, duplicate, oversized and invalid XML attachments", async () => {
  const empty = await PDFDocument.create(); empty.addPage();
  expect((await einvoice.parsePdf(await empty.save())).ok).toBe(false);
  const pdf = await pdfWithInvoice();
  await pdf.attach(new TextEncoder().encode(xml()), "zugferd-invoice.xml");
  expect((await einvoice.parsePdf(await pdf.save())).ok).toBe(false);
  const bytes = await (await pdfWithInvoice()).save();
  expect((await einvoice.parsePdf(bytes, { maxPdfBytes: 1 })).ok).toBe(false);
  expect((await einvoice.parsePdf(bytes, { maxCharacters: 1 })).ok).toBe(false);
  expect((await einvoice.parsePdf(new Uint8Array([1, 2, 3]))).ok).toBe(false);
});

test("reads independent Cloud / Factur-X 1.2.0 output", async () => {
  const source = await Bun.file(new URL("../../examples/fixtures/einvoice/cloud-factur-x-1.2.0.xml", import.meta.url)).text();
  const parsed = unwrap(einvoice.parseXml(source));
  expect(parsed.invoice.number).toBe(sample.number);
  expect(parsed.invoice.totals?.grossAmount).toBe("140.40");
  expect(await validateInvoiceXml(source, { format })).toEqual({ ok: true, data: undefined });
});

test("XSD entry point rejects another guideline and DTD before WASM", async () => {
  const source = xml();
  for (const value of [source.replace("urn:cen.eu:en16931:2017", "urn:other"), source.replace("<rsm:CrossIndustryInvoice", "<!DOCTYPE x><rsm:CrossIndustryInvoice")]) {
    expect((await validateInvoiceXml(value, { format })).ok).toBe(false);
  }
});

test("extreme decimal inputs remain calculable but cannot generate unsupported amounts", () => {
  const large = "9".repeat(200);
  const input = { ...sample, lines: [{ ...sample.lines[0]!, quantity: large, unitPrice: large }] };
  expect(einvoice.calculate(input.lines).ok).toBe(true);
  expect(einvoice.validate(input).ok).toBe(false);
  expect(einvoice.serialize(input, { format }).ok).toBe(false);
});

test("malformed and oversized numeric strings return errors instead of throwing", () => {
  for (const value of ["NaN", "Infinity", "1e999999999", "", "-1", "9".repeat(201)]) {
    for (const field of ["quantity", "unitPrice", "taxRate"] as const) {
      const lines = [{ ...sample.lines[0]!, [field]: value }];
      expect(einvoice.validate({ ...sample, lines }).ok).toBe(false);
      expect(einvoice.calculate(lines).ok).toBe(false);
      expect(einvoice.serialize({ ...sample, lines }, { format }).ok).toBe(false);
    }
  }
});

test("validate and serialize reject the same inconsistent declared amounts with precise paths", () => {
  const valid = unwrap(einvoice.parseXml(xml())).invoice;
  const totals = valid.totals!;
  const cases = [
    { input: { ...valid, lines: [{ ...valid.lines[0]!, netAmount: "1.00" }, valid.lines[1]!] }, path: ["lines", 0, "netAmount"] },
    ...(["netAmount", "taxAmount", "grossAmount", "dueAmount"] as const).map(field => ({ input: { ...valid, totals: { ...totals, [field]: "1.00" } }, path: ["totals", field] })),
    { input: { ...valid, totals: { ...totals, taxGroups: [{ ...totals.taxGroups[0]!, taxAmount: "1.00" }, totals.taxGroups[1]!] } }, path: ["totals", "taxGroups", 0, "taxAmount"] },
    { input: { ...valid, totals: { ...totals, taxGroups: [...totals.taxGroups, totals.taxGroups[0]!] } }, path: ["totals", "taxGroups", 2, "taxRate"] },
    { input: { ...valid, totals: { ...totals, taxGroups: [totals.taxGroups[0]!] } }, path: ["totals", "taxGroups"] },
  ];
  for (const { input, path } of cases) {
    const checked = einvoice.validate(input);
    expect(checked.ok).toBe(false);
    const serialized = einvoice.serialize(input, { format });
    expect(serialized.ok).toBe(false);
    if (!checked.ok && !serialized.ok) expect(serialized.error).toEqual(checked.error);
    if (!checked.ok) expect(checked.error.issues.some(issue => JSON.stringify(issue.path) === JSON.stringify(path))).toBe(true);
  }
  expect(unwrap(einvoice.validate(valid))).toEqual(valid);
  expect(unwrap(einvoice.validate(sample)).totals).toBeUndefined();
});

test("format country and VAT prefix rules reject unsupported codes before serialization", () => {
  for (const party of ["seller", "buyer"] as const) {
    expect(einvoice.validate({ ...sample, [party]: { ...sample[party], vatId: "ZZ123" } }).ok).toBe(false);
    expect(einvoice.validate({ ...sample, [party]: { ...sample[party], address: { ...sample[party].address, countryCode: "ZZ" } } }).ok).toBe(false);
    expect(einvoice.validate({ ...sample, [party]: { ...sample[party], vatId: "EL123456789", address: { ...sample[party].address, countryCode: "GR" } } }).ok).toBe(true);
  }
  expect(einvoice.validate({ ...sample, invoiceDate: "0000-01-01" }).ok).toBe(false);
});

test("supported output amount boundary is checked after rounding and tax", async () => {
  const input = { ...sample, lines: [{ ...sample.lines[0]!, quantity: "1", unitPrice: "8403361344.5294" }] };
  expect(unwrap(einvoice.calculate(input.lines)).grossAmount).toBe("9999999999.99");
  expect(einvoice.validate(input).ok).toBe(true);
  expect((await validateInvoiceXml(xml(input), { format })).ok).toBe(true);
  const above = { ...input, lines: [{ ...input.lines[0]!, unitPrice: "8403361344.54" }] };
  const result = einvoice.validate(above);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.issues[0]?.path).toEqual(["totals", "grossAmount"]);
});

test("the pinned country list accepts 1A consistently for addresses and VAT prefixes", async () => {
  const input = { ...sample, seller: { ...sample.seller, vatId: "1A123456789", address: { ...sample.seller.address, countryCode: "1A" } } };
  expect(einvoice.validate(input).ok).toBe(true);
  const source = xml(input);
  expect((await validateInvoiceXml(source, { format })).ok).toBe(true);
  expect(unwrap(einvoice.parseXml(source)).invoice.seller).toEqual(input.seller);
  for (const countryCode of ["ZZ", "1B", "", "DE ", "de"]) {
    expect(einvoice.validate({ ...input, seller: { ...input.seller, address: { ...input.seller.address, countryCode } } }).ok).toBe(false);
  }
});

test("parsing preserves large declared amounts independently of generation limits", () => {
  for (const amount of ["9007199254740993.01", `${"9".repeat(200)}.99`]) {
    const price = amount.length > 200 ? amount.split(".")[0]! : amount;
    const source = xml()
      .replace("<ram:ChargeAmount>50.0000", `<ram:ChargeAmount>${price}`)
      .replace("<ram:LineTotalAmount>100.00", `<ram:LineTotalAmount>${amount}`)
      .replace("<ram:GrandTotalAmount>140.40", `<ram:GrandTotalAmount>${amount}`);
    const parsed = unwrap(einvoice.parseXml(source));
    expect(parsed.xml).toBe(source);
    expect(parsed.invoice.lines[0]?.unitPrice).toBe(price);
    expect(parsed.invoice.lines[0]?.netAmount).toBe(amount);
    expect(parsed.invoice.totals?.grossAmount).toBe(amount);
    expect(einvoice.validate(parsed.invoice).ok).toBe(false);
    expect(einvoice.serialize(parsed.invoice, { format }).ok).toBe(false);
  }
});

const categoryInvoice = (taxCategory: NonNullable<Invoice["lines"][number]["taxCategory"]>): Invoice => ({
  ...sample,
  seller: { ...sample.seller, id: "SELLER-1", vatId: taxCategory === "O" ? "" : sample.seller.vatId },
  buyer: { ...sample.buyer, vatId: taxCategory === "O" ? "" : sample.buyer.vatId },
  ...(taxCategory === "K" ? { deliverToCountryCode: "FR" } : {}),
  lines: [{ ...sample.lines[0]!, taxCategory, taxRate: taxCategory === "S" ? "19" : "0",
    ...({ E: { taxExemptionReasonCode: "VATEX-EU-J" }, AE: { taxExemptionReasonCode: "VATEX-EU-AE" }, K: { taxExemptionReasonCode: "VATEX-EU-IC" }, G: { taxExemptionReasonCode: "VATEX-EU-G" }, O: { taxExemptionReasonCode: "VATEX-EU-O" }, S: {}, Z: {} }[taxCategory]),
  }],
});

for (const category of ["S", "Z", "E", "AE", "K", "G", "O"] as const) {
  test(`${category}: category, rate and exemption survive XML/XSD roundtrip`, async () => {
    const input = categoryInvoice(category);
    const source = xml(input);
    expect((await validateInvoiceXml(source, { format })).ok).toBe(true);
    const parsed = unwrap(einvoice.parseXml(source)).invoice;
    expect(parsed).toMatchObject(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)));
    expect(parsed.totals?.taxGroups[0]).toMatchObject({ taxCategory: category, taxRate: input.lines[0]!.taxRate, ...(category !== "S" ? { taxAmount: "0.00" } : {}) });
    expect(einvoice.validate(parsed).ok).toBe(true);
    expect(xml(parsed)).toBe(source);
    if (category === "O") {
      expect(source).not.toContain("RateApplicablePercent");
      expect(source).not.toContain('schemeID="VA"');
      expect(einvoice.parseXml(source.replace("<ram:CategoryCode>O</ram:CategoryCode>", "<ram:CategoryCode>O</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent>")).ok).toBe(false);
    }
  });

  test(`${category}: invalid rates fail calculation, validation and generation`, () => {
    const input = categoryInvoice(category);
    input.lines[0]!.taxRate = category === "S" ? "0" : "19";
    expect(einvoice.calculate(input.lines).ok).toBe(false);
    expect(einvoice.validate(input).ok).toBe(false);
    expect(einvoice.serialize(input, { format }).ok).toBe(false);
  });
}

test("omitted category keeps the legacy S calculation and byte output", async () => {
  const totals = unwrap(einvoice.calculate(sample.lines));
  expect(totals.taxGroups[0]).toEqual({ taxRate: "19.00", netAmount: "100.00", taxAmount: "19.00" });
  expect(xml({ ...sample, lines: sample.lines.map(line => ({ ...line, taxCategory: "S" })) })).toBe(xml(sample));
});

test("S+E mixes while E/Z/AE at the same zero rate remain distinct", async () => {
  const categories = ["S", "E", "Z", "AE"] as const;
  const input: Invoice = { ...sample, lines: categories.map((category, index) => ({ ...categoryInvoice(category).lines[0]!, id: String(index) })) };
  const parsed = unwrap(einvoice.parseXml(xml(input))).invoice;
  expect(parsed.totals?.taxGroups.map(group => group.taxCategory)).toEqual([...categories]);
  expect(parsed.totals).toMatchObject({ netAmount: "400.00", taxAmount: "19.00", grossAmount: "419.00" });
  expect((await validateInvoiceXml(xml(parsed), { format })).ok).toBe(true);
  const mixed: Invoice = { ...input, lines: input.lines.slice(0, 2) };
  expect(unwrap(einvoice.parseXml(xml(mixed))).invoice.totals).toMatchObject({ netAmount: "200.00", taxAmount: "19.00", grossAmount: "219.00" });
});

for (const taxExemptionReasonCode of ["VATEX-EU-F", "VATEX-EU-I", "VATEX-EU-J"]) {
  test(`margin scheme ${taxExemptionReasonCode}: zero disclosed tax and retained reason`, async () => {
    const input = categoryInvoice("E");
    Object.assign(input.lines[0]!, { taxExemptionReasonCode, taxExemptionReason: "Differenzbesteuerung nach § 25a UStG", unitPrice: "1234.5678" });
    const source = xml(input);
    expect((await validateInvoiceXml(source, { format })).ok).toBe(true);
    const parsed = unwrap(einvoice.parseXml(source)).invoice;
    expect(parsed.lines[0]).toMatchObject(input.lines[0]!);
    expect(parsed.totals?.taxGroups[0]).toMatchObject({ taxCategory: "E", taxAmount: "0.00", taxExemptionReasonCode });
    expect(xml(parsed)).toBe(source);
  });
}

test("reasons can be supplied only on the tax group and are projected onto parsed lines", () => {
  const input = categoryInvoice("E");
  delete input.lines[0]!.taxExemptionReasonCode;
  const { lines, ...totals } = unwrap(einvoice.calculate(input.lines));
  input.totals = { ...totals, taxGroups: totals.taxGroups.map(group => ({ ...group, taxExemptionReason: "Steuerbefreit nach § 4 UStG" })) };
  const parsed = unwrap(einvoice.parseXml(xml(input))).invoice;
  expect(parsed.lines[0]?.taxExemptionReason).toBe(input.totals.taxGroups[0]!.taxExemptionReason);
  expect(parsed.totals).toEqual(input.totals);
  expect(xml(parsed)).toBe(xml(input));
  const inconsistent = { ...parsed, lines: [{ ...parsed.lines[0]!, taxExemptionReason: "Different reason" }] };
  expect(einvoice.validate(inconsistent).ok).toBe(false);
  expect(einvoice.serialize(inconsistent, { format }).ok).toBe(false);
});

test("one category/rate group combines equivalent rates and rejects conflicting reasons", () => {
  const line = categoryInvoice("E").lines[0]!;
  const input: Invoice = { ...sample, lines: [line, { ...line, id: "2", taxRate: "0.0000" }] };
  expect(unwrap(einvoice.calculate(input.lines)).taxGroups).toHaveLength(1);
  expect(unwrap(einvoice.parseXml(xml(input))).invoice.totals?.taxGroups).toHaveLength(1);
  input.lines[1]!.taxExemptionReasonCode = "VATEX-EU-F";
  expect(einvoice.calculate(input.lines).ok).toBe(false);
  expect(einvoice.validate(input).ok).toBe(false);
});

test("category rules reject missing, forbidden and mismatched exemption reasons", () => {
  for (const category of ["E", "AE", "K", "G", "O"] as const) {
    const input = categoryInvoice(category);
    delete input.lines[0]!.taxExemptionReasonCode;
    expect(einvoice.validate(input).ok).toBe(false);
    expect(einvoice.serialize(input, { format }).ok).toBe(false);
    input.lines[0]!.taxExemptionReason = ({ E: "Steuerbefreit", AE: "Steuerschuldnerschaft des Leistungsempfängers", K: "Innergemeinschaftliche Lieferung", G: "Ausfuhrlieferung", O: "Nicht steuerbar" })[category];
    expect(einvoice.validate(input).ok).toBe(true);
    expect(unwrap(einvoice.parseXml(xml(input))).invoice.lines[0]?.taxExemptionReason).toBe(input.lines[0]!.taxExemptionReason);
    input.lines[0]!.taxExemptionReasonCode = "VATEX-UNKNOWN";
    expect(einvoice.validate(input).ok).toBe(false);
  }
  for (const category of ["S", "Z"] as const) {
    const input = categoryInvoice(category);
    input.lines[0]!.taxExemptionReason = "Forbidden";
    expect(einvoice.validate(input).ok).toBe(false);
  }
  const input = categoryInvoice("E");
  input.lines[0]!.taxExemptionReasonCode = "VATEX-EU-AE";
  expect(einvoice.validate(input).ok).toBe(false);
});

test("VAT identities, O exclusivity and intra-community delivery country", async () => {
  for (const category of ["AE", "K"] as const) {
    const input = categoryInvoice(category);
    input.buyer.vatId = "";
    expect(einvoice.validate(input).ok).toBe(false);
  }
  const intra = categoryInvoice("K");
  delete intra.deliverToCountryCode;
  expect(einvoice.validate(intra).ok).toBe(false);
  for (const party of ["seller", "buyer"] as const) {
    const input = categoryInvoice("O");
    input[party].vatId = sample[party].vatId;
    expect(einvoice.validate(input).ok).toBe(false);
  }
  const outside = categoryInvoice("O");
  outside.lines.push({ ...sample.lines[0]!, id: "2" });
  expect(einvoice.validate(outside).ok).toBe(false);
  expect(einvoice.calculate(outside.lines).ok).toBe(false);
  const exempt = categoryInvoice("E");
  exempt.seller.vatId = "";
  exempt.buyer.vatId = "";
  expect(einvoice.validate(exempt).ok).toBe(false);
  exempt.seller.taxRegistrationId = "123/456/78901";
  const source = xml(exempt);
  expect((await validateInvoiceXml(source, { format })).ok).toBe(true);
  expect(unwrap(einvoice.parseXml(source)).invoice).toMatchObject(exempt);
});

test("reader rejects duplicate/missing category groups, nonzero exempt tax and missing reasons", () => {
  const source = xml(categoryInvoice("E"));
  const group = source.match(/<ram:ApplicableTradeTax><ram:CalculatedAmount>.*?<\/ram:ApplicableTradeTax>/)![0];
  for (const damaged of [
    source.replace(group, group + group), source.replace(group, ""),
    source.replace("<ram:CalculatedAmount>0.00", "<ram:CalculatedAmount>1.00"),
    source.replace("<ram:ExemptionReasonCode>VATEX-EU-J</ram:ExemptionReasonCode>", ""),
    source.replace("<ram:ExemptionReasonCode>VATEX-EU-J", "<ram:ExemptionReasonCode>VATEX-EU-AE"),
  ]) expect(einvoice.parseXml(damaged).ok).toBe(false);
});

test("explicit undefined group reasons cannot erase reasons supplied on lines", () => {
  const input = categoryInvoice("E");
  const { lines, ...totals } = unwrap(einvoice.calculate(input.lines));
  input.totals = { ...totals, taxGroups: totals.taxGroups.map(group => ({ ...group, taxExemptionReasonCode: undefined })) };
  expect(unwrap(einvoice.parseXml(xml(input))).invoice.totals?.taxGroups[0]?.taxExemptionReasonCode).toBe("VATEX-EU-J");
});

test("seller identity is required without VAT ID, and empty XML VAT registrations are rejected", () => {
  const input = categoryInvoice("O");
  delete input.seller.id;
  expect(einvoice.validate(input).ok).toBe(false);
  expect(einvoice.serialize(input, { format }).ok).toBe(false);
  const source = xml(categoryInvoice("O"));
  const damaged = source.replace("</ram:SellerTradeParty>", '<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA"></ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty>');
  expect(einvoice.parseXml(damaged).ok).toBe(false);
});

for (const kind of ["invoice", "creditNote", "selfBilling", "selfBillingCreditNote"] as const) {
  for (const typeCode of [undefined, "10", "30", "58", "68", "97"] as const) {
    test(`${kind}: payment ${typeCode ?? "absent"} round trip and XSD`, async () => {
      const payment: Invoice["payment"] = typeCode === undefined ? undefined : {
        typeCode, information: "Payment & settlement <agreed>",
        ...(["30", "58"].includes(typeCode) ? sample.payment : {}),
      };
      const input: Invoice = { ...sample, kind, payment, precedingInvoice: { number: "ORIGINAL", invoiceDate: "2026-08-01" } };
      const source = xml(input);
      expect((await validateInvoiceXml(source, { format })).ok).toBe(true);
      const parsed = unwrap(einvoice.parseXml(source)).invoice;
      expect(parsed).toMatchObject(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)));
      expect(xml(parsed)).toBe(source);
      if (!payment) expect(source).not.toContain("SpecifiedTradeSettlementPaymentMeans");
      else if (typeCode !== "30" && typeCode !== "58") expect(source).not.toContain("PayeePartyCreditorFinancialAccount");
      const pdf = await pdfWithInvoice(source);
      expect(unwrap(await einvoice.parsePdf(await pdf.save())).invoice).toEqual(parsed);
    });
  }
}

for (const period of [{ startDate: "2026-08-01" }, { endDate: "2026-08-15" }, { startDate: "2026-08-01", endDate: "2026-08-15" }, { startDate: "2026-08-15", endDate: "2026-08-15" }]) {
  test(`period ${JSON.stringify(period)} without serviceDate round trip and XSD`, async () => {
    const input = { ...sample, serviceDate: undefined, period };
    const source = xml(input);
    expect(source).not.toContain("ActualDeliverySupplyChainEvent");
    expect((await validateInvoiceXml(source, { format })).ok).toBe(true);
    expect(unwrap(einvoice.parseXml(source)).invoice.period).toEqual(period);
    expect(unwrap(einvoice.parseXml(source)).invoice.serviceDate).toBeUndefined();
    expect(xml(unwrap(einvoice.parseXml(source)).invoice)).toBe(source);
    expect(unwrap(einvoice.parseXml(xml({ ...sample, period }))).invoice.serviceDate).toBe(sample.serviceDate);
  });
}

test("legacy invoice output remains byte-identical; omitted payment code still means 58", () => {
  // Captured from the 0.26.0 writer, before changing generation.
  expect(new Bun.CryptoHasher("sha256").update(xml()).digest("hex")).toBe("dec59d286699bb245b0c4de7850d32d6265e59b7479b273b28d8ab573ddba66d");
  expect(xml({ ...sample, payment: { ...sample.payment, typeCode: "58" } })).toBe(xml());
  expect(unwrap(einvoice.parseXml(xml())).invoice.payment?.typeCode).toBe("58");
  const noAccountName = xml({ ...sample, payment: { iban: "DE89370400440532013000" } });
  expect(noAccountName).not.toContain("AccountName");
  expect(xml(unwrap(einvoice.parseXml(noAccountName)).invoice)).toBe(noAccountName);
});

test("payment, period and preceding invoice invalid combinations are rejected locally", () => {
  for (const payment of [{}, { typeCode: "30" }, { typeCode: "58" }, { typeCode: "999" }, { typeCode: "59" }, { typeCode: "" }, { typeCode: "68", iban: sample.payment?.iban }, { typeCode: "10", accountName: "Seller" }, { iban: "not-an-iban" }, { typeCode: "68", information: "\0" }]) {
    expect(einvoice.validate({ ...sample, payment }).ok).toBe(false);
  }
  for (const period of [{}, { startDate: "2026-02-30" }, { endDate: "0000-01-01" }, { startDate: "2026-08-15", endDate: "2026-08-01" }]) expect(einvoice.validate({ ...sample, period }).ok).toBe(false);
  for (const precedingInvoice of [{ number: "", invoiceDate: "2026-08-01" }, { number: "ORIGINAL", invoiceDate: "2026-08-23" }]) expect(einvoice.validate({ ...sample, precedingInvoice }).ok).toBe(false);
  const missing = einvoice.validate({ ...sample, kind: "creditNote" });
  const future = einvoice.validate({ ...sample, precedingInvoice: { number: "ORIGINAL", invoiceDate: "2026-08-23" } });
  expect(missing.ok).toBe(false); expect(future.ok).toBe(false);
  if (!missing.ok && !future.ok) {
    expect(missing.error.issues[0]?.message).toContain("require an original");
    expect(future.error.issues[0]?.path).toEqual(["precedingInvoice", "invoiceDate"]);
    expect(future.error.issues[0]?.message).toContain("must not follow");
  }
});

test("strict reader rejects missing transfer accounts even where Schematron has no matching context", () => {
  const source = xml();
  const noAccount = source.replace(/<ram:PayeePartyCreditorFinancialAccount>.*?<\/ram:PayeePartyCreditorFinancialAccount>/, "");
  const invalid = [noAccount, noAccount.replace("<ram:TypeCode>58", "<ram:TypeCode>30"),
    source.replace("<ram:TypeCode>58</ram:TypeCode>", ""),
    source.replace("<ram:TypeCode>58", "<ram:TypeCode>999"),
    source.replace("<ram:TypeCode>58", "<ram:TypeCode>68"),
    source.replace(/<ram:IBANID>.*?<\/ram:IBANID>/, ""),
    source.replace("<ram:SpecifiedTradePaymentTerms>", "<ram:BillingSpecifiedPeriod/><ram:SpecifiedTradePaymentTerms>"),
    xml({ ...sample, period: { startDate: "2026-08-01", endDate: "2026-08-15" } }).replace("20260801", "20260816"),
    xml({ ...sample, precedingInvoice: { number: "ORIGINAL", invoiceDate: "2026-08-01" } }).replace("<ram:IssuerAssignedID>ORIGINAL", "<ram:IssuerAssignedID>"),
  ];
  for (const input of invalid) expect(einvoice.parseXml(input).ok).toBe(false);
});

test("K requires a delivery date or nonempty header period", async () => {
  const input: Invoice = { ...sample, serviceDate: undefined, deliverToCountryCode: "FR",
    lines: [{ ...sample.lines[0]!, taxCategory: "K", taxRate: "0", taxExemptionReasonCode: "VATEX-EU-IC" }] };
  expect(einvoice.validate(input).ok).toBe(false);
  expect(einvoice.validate({ ...input, period: {} }).ok).toBe(false);
  for (const period of [{ startDate: "2026-08-01" }, { endDate: "2026-08-15" }]) {
    const source = xml({ ...input, period });
    expect((await validateInvoiceXml(source, { format })).ok).toBe(true);
    expect(unwrap(einvoice.parseXml(source)).invoice.period).toEqual(period);
  }
});
