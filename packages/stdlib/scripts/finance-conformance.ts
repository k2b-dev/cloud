/** Independent CI checks. Requires Java 11+ and Python 3; no runtime package dependency. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoice } from "../examples/einvoice";
import { additionalInvoice, creditNote, additionalSelfBilling, selfBillingCreditNote } from "../examples/einvoice-options";
import { marginInvoice } from "../examples/einvoice-margin";
import { datevExample, sepaExample } from "../examples/finance";
import { datevXmlExample, samplePdf } from "../examples/datev-xml";
import { ensureDatevXmlFixtures } from "./datev-xml-fixtures";
import { loadDatevXmlSchemas } from "../src/bun";
import { datev, sepa, einvoice, type Invoice } from "../src/finance";
import { createDatevXmlPackage, validateInvoiceXml, validateSepaXml } from "../src/finance/validate";
import { unwrap } from "../src/result";

const artifacts = [
  { name: "saxon.jar", url: "https://repo.maven.apache.org/maven2/net/sf/saxon/Saxon-HE/10.9/Saxon-HE-10.9.jar", sha256: "491d8edf4ec811d15c2b2417b007218b9b938f15e4dfbad004025beb4e70e960" },
  { name: "cii.xslt", url: "https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/validation-1.3.16/cii/xslt/EN16931-CII-validation.xslt", sha256: "0b234dea2bbfee739b7761e607a992c17fab88773014ef56355b6158cfb1cc53" },
];
const cache = join(tmpdir(), "stdlib-finance-conformance");
await mkdir(cache, { recursive: true });
for (const artifact of artifacts) {
  const path = join(cache, artifact.sha256 + "-" + artifact.name);
  if (!await Bun.file(path).exists()) {
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Download failed: ${artifact.url}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error(`Integrity failure: ${artifact.name}`);
    await Bun.write(path, bytes);
  }
  if (new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex") !== artifact.sha256) throw new Error(`Cached integrity failure: ${artifact.name}`);
}
const work = await mkdtemp(join(tmpdir(), "stdlib-finance-cases-"));
try {
  await mkdir(join(work, "invoices"));
  await mkdir(join(work, "reports"));
  const cases: Record<string, Invoice> = {};
  for (const kind of ["invoice", "creditNote", "selfBilling", "selfBillingCreditNote"] as const) {
    cases[kind] = { ...invoice, kind, ...((kind === "creditNote" || kind === "selfBillingCreditNote") ? { precedingInvoice: { number: "ORIGINAL", invoiceDate: "2026-08-01" } } : {}) };
  }
  cases.additionalInvoice = additionalInvoice;
  // BT-35/BT-50 are optional, for either supplier/customer and document kind.
  for (const kind of ["invoice", "creditNote", "selfBilling", "selfBillingCreditNote"] as const) {
    for (const swapped of [false, true]) for (const absent of ["seller", "buyer", "both"]) {
      for (const line1 of [undefined, ""]) {
        const input = structuredClone({ ...cases[kind]!,
          seller: swapped ? invoice.buyer : invoice.seller, buyer: swapped ? invoice.seller : invoice.buyer,
        });
        for (const party of ["seller", "buyer"] as const) if (absent === party || absent === "both") {
          if (line1 === undefined) delete input[party].address.line1;
          else input[party].address.line1 = line1;
        }
        cases[`${kind}-address-${absent}-${swapped}-${line1 === undefined ? "omitted" : "empty"}`] = input;
      }
    }
  }
  cases.creditWithoutPayment = creditNote;
  cases.additionalSelfBilling = additionalSelfBilling;
  cases.selfBilledReduction = selfBillingCreditNote;
  for (const kind of ["invoice", "creditNote", "selfBilling", "selfBillingCreditNote"] as const) {
    for (const typeCode of [undefined, "10", "30", "58", "68", "97"] as const) {
      cases[`${kind}-payment-${typeCode ?? "absent"}`] = { ...cases[kind]!,
        payment: typeCode ? { typeCode, information: "Settlement", ...(["30", "58"].includes(typeCode) ? invoice.payment : {}) } : undefined };
    }
  }
  cases["no-service-date"] = { ...invoice, serviceDate: undefined };
  cases["period-start"] = { ...invoice, serviceDate: undefined, period: { startDate: "2026-08-01" } };
  cases["period-end"] = { ...invoice, serviceDate: undefined, period: { endDate: "2026-08-15" } };
  cases["period-both"] = { ...invoice, period: { startDate: "2026-08-01", endDate: "2026-08-15" } };
  const line = invoice.lines[0]!;
  cases.rounding = { ...invoice, lines: Array.from({ length: 3 }, (_, i) => ({ ...line, id: String(i), quantity: "1.0000", unitPrice: "1.0050" })) };
  // Explicit BT-114 changes the amount due, never the net-group VAT calculation.
  for (const kind of ["invoice", "creditNote", "selfBilling", "selfBillingCreditNote"] as const) {
    const examples = [
      { name: "19-small", prices: [["0.03", "19"]], roundingAmount: "-0.01" },
      { name: "19-large", prices: [["84.03", "19"]], roundingAmount: "-0.01" },
      { name: "19-two-lines", prices: [["44.03", "19"], ["49.04", "19"]], roundingAmount: "0.00" },
      { name: "7-small", prices: [["0.07", "7"]], roundingAmount: "0.01" },
      { name: "20-tax-first-basis", prices: [["0.02", "20"]], roundingAmount: "0.01" },
      { name: "20-net-first-basis", prices: [["0.03", "20"]], roundingAmount: "-0.01" },
      { name: "mixed", prices: [["84.03", "19"], ["93.45", "7"], ["0.02", "20"]], roundingAmount: "0.00" },
      { name: "zero-due", prices: [["0.02", "20"]], roundingAmount: "-0.02" },
    ];
    for (const c of examples) {
      const inputLines = c.prices.map(([unitPrice, taxRate], i) => ({ ...line, id: String(i), quantity: "1", unitPrice: unitPrice!, taxRate: taxRate! }));
      const { lines, ...totals } = unwrap(einvoice.calculate(inputLines, { roundingAmount: c.roundingAmount }));
      cases[`${kind}-rounding-${c.name}`] = { ...cases[kind]!, lines, totals };
    }
  }
  cases.units = { ...invoice, lines: (["C62", "HUR", "DAY", "KGM"] as const).map((unitCode, i) => ({ ...line, id: String(i), unitCode })) };
  cases.greek = { ...invoice, seller: { ...invoice.seller, vatId: "EL123456789", address: { ...invoice.seller.address, countryCode: "GR" } } };
  cases.kosovo = { ...invoice, seller: { ...invoice.seller, vatId: "1A123456789", address: { ...invoice.seller.address, countryCode: "1A" } } };
  cases.zero = { ...invoice, lines: [{ ...line, unitPrice: "0" }] };
  cases.precision = { ...invoice, lines: [{ ...line, quantity: "0.0001", unitPrice: "99999.9999", taxRate: "7.1250" }] };
  cases.large = { ...invoice, lines: [{ ...line, quantity: "1", unitPrice: "8403361344.5294" }] };
  cases.many = { ...invoice, lines: Array.from({ length: 1000 }, (_, i) => ({ ...line, id: String(i), quantity: "1", unitPrice: "8403361.3350" })) };
  cases.characters = { ...invoice, number: 'RE <&> "ä"', notes: ["Agreement & terms\r\n<signed>"], lines: [{ ...line, name: 'Äpfel & Öl <"A">', description: "Line\nTwo" }] };
  cases.rates = { ...invoice, lines: ["7", "19", "19.0000", "0.0001", "100"].map((taxRate, i) => ({ ...line, id: String(i), taxRate, unitPrice: "1.0050", quantity: "3.3333" })) };
  for (const taxCategory of ["Z", "E", "AE", "K", "G", "O"] as const) {
    const taxExemptionReasonCode = { Z: undefined, E: "VATEX-EU-J", AE: "VATEX-EU-AE", K: "VATEX-EU-IC", G: "VATEX-EU-G", O: "VATEX-EU-O" }[taxCategory];
    cases[`category-${taxCategory}`] = { ...invoice,
      seller: { ...invoice.seller, id: "SELLER-1", vatId: taxCategory === "O" ? "" : invoice.seller.vatId },
      buyer: { ...invoice.buyer, vatId: taxCategory === "O" ? "" : invoice.buyer.vatId },
      ...(taxCategory === "K" ? { deliverToCountryCode: "FR" } : {}),
      lines: [{ ...line, taxCategory, taxRate: "0", ...(taxExemptionReasonCode ? { taxExemptionReasonCode } : {}) }],
    };
  }
  for (const code of ["F", "I", "J"]) cases[`margin-${code}`] = { ...marginInvoice, lines: [{ ...marginInvoice.lines[0]!, taxExemptionReasonCode: `VATEX-EU-${code}` }] };
  cases["mixed-S-E"] = { ...invoice, lines: [line, { ...marginInvoice.lines[0]!, id: "2" }] };
  cases["mixed-zero-categories"] = { ...invoice, lines: ["E", "Z", "AE"].map((category, i) => ({ ...cases[`category-${category}`]!.lines[0]!, id: String(i) })) };
  cases["exempt-tax-registration"] = { ...marginInvoice, seller: { ...invoice.seller, id: "SELLER-1", vatId: "", taxRegistrationId: "123/456/78901" }, buyer: { ...invoice.buyer, vatId: "" } };
  cases["exempt-text-only"] = { ...marginInvoice, lines: [{ ...marginInvoice.lines[0]!, taxExemptionReasonCode: undefined }] };
  cases["K-period-start"] = { ...cases["category-K"]!, serviceDate: undefined, period: { startDate: "2026-08-01" } };
  cases["K-period-end"] = { ...cases["category-K"]!, serviceDate: undefined, period: { endDate: "2026-08-15" } };
  for (const [name, input] of Object.entries(cases)) {
    const file = unwrap(einvoice.serialize(input, { format: "zugferd-2.5-en16931" }));
    unwrap(await validateInvoiceXml(file.xml, { format: file.format }));
    const parsed = unwrap(einvoice.parseXml(file.xml));
    unwrap(einvoice.validate(parsed.invoice));
    if (unwrap(einvoice.serialize(parsed.invoice, { format: file.format })).xml !== file.xml) throw new Error(`Strict roundtrip differs: ${name}`);
    await Bun.write(join(work, "invoices", `${name}.xml`), file.xml);
  }
  const xml = unwrap(einvoice.serialize(invoice, { format: "zugferd-2.5-en16931" })).xml;
  // Schematron must reject each business-rule violation. Missing payment TypeCode
  // is also rejected by XSD; the remaining mutations must stay XSD-valid.
  const invalid: Record<string, string> = {
    "bad-payment-code": xml.replace("<ram:TypeCode>58", "<ram:TypeCode>999"),
    "bad-payment-missing-code": xml.replace("<ram:TypeCode>58</ram:TypeCode>", ""),
    "bad-payment-account": xml.replace(/<ram:IBANID>.*?<\/ram:IBANID>/, ""),
    "bad-period-empty": xml.replace("<ram:SpecifiedTradePaymentTerms>", "<ram:BillingSpecifiedPeriod/><ram:SpecifiedTradePaymentTerms>"),
    "bad-period-order": unwrap(einvoice.serialize(cases["period-both"]!, { format: "zugferd-2.5-en16931" })).xml.replace("20260801", "20260816"),
    "bad-reference-id": unwrap(einvoice.serialize(additionalInvoice, { format: "zugferd-2.5-en16931" })).xml.replace(/<ram:IssuerAssignedID>.*?<\/ram:IssuerAssignedID>/, "<ram:IssuerAssignedID/>"),
    "bad-rounding-due": xml.replace("<ram:GrandTotalAmount>", "<ram:RoundingAmount>0.01</ram:RoundingAmount><ram:GrandTotalAmount>"),
    "bad-rounding-scale": xml.replace("<ram:GrandTotalAmount>", "<ram:RoundingAmount>0.001</ram:RoundingAmount><ram:GrandTotalAmount>"),
    "bad-total": xml.replace("<ram:GrandTotalAmount>140.40", "<ram:GrandTotalAmount>999.00"),
    "bad-tax": xml.replace("<ram:CalculatedAmount>19.00", "<ram:CalculatedAmount>18.00"),
    "bad-country": xml.replace("<ram:CountryID>DE", "<ram:CountryID>ZZ"),
    "bad-vat": xml.replace(invoice.seller.vatId, "ZZ123456789"),
  };
  for (const category of ["E", "Z", "O", "AE", "K", "G"] as const) {
    const source = unwrap(einvoice.serialize(cases[`category-${category}`]!, { format: "zugferd-2.5-en16931" })).xml;
    invalid[`bad-${category}-tax`] = source.replace("<ram:CalculatedAmount>0.00", "<ram:CalculatedAmount>1.00");
    invalid[`bad-${category}-basis`] = source.replace("<ram:BasisAmount>100.00", "<ram:BasisAmount>99.00");
    if (category !== "Z") invalid[`bad-${category}-reason`] = source.replace(/<ram:ExemptionReasonCode>[^<]+<\/ram:ExemptionReasonCode>/, "");
    if (category === "Z") invalid["bad-Z-reason"] = source.replace("<ram:BasisAmount>", "<ram:ExemptionReason>Forbidden</ram:ExemptionReason><ram:BasisAmount>");
    if (category === "K") invalid["bad-K-date"] = source.replace(/<ram:ActualDeliverySupplyChainEvent>.*?<\/ram:ActualDeliverySupplyChainEvent>/, "");
    if (category === "K") invalid["bad-K-country"] = source.replace(/<ram:ShipToTradeParty>.*?<\/ram:ShipToTradeParty>/, "");
    if (category === "O") invalid["bad-O-rate"] = source.replace("<ram:CategoryCode>O</ram:CategoryCode>", "<ram:CategoryCode>O</ram:CategoryCode><ram:RateApplicablePercent>0</ram:RateApplicablePercent>");
    if (category === "AE" || category === "K") invalid[`bad-${category}-buyer`] = source.replace(`<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${invoice.buyer.vatId}</ram:ID></ram:SpecifiedTaxRegistration>`, "");
  }
  for (const [name, source] of Object.entries(invalid)) {
    if (source === xml) throw new Error(`Mutation did not apply: ${name}`);
    const xsd = await validateInvoiceXml(source, { format: "zugferd-2.5-en16931" });
    if (name === "bad-payment-missing-code") {
      if (xsd.ok) throw new Error(`${name}: expected XSD rejection`);
    } else if (!xsd.ok) throw new Error(`${name}: ${JSON.stringify(xsd.error.issues)}`);
    await Bun.write(join(work, "invoices", `${name}.xml`), source);
  }
  const java = Bun.spawn(["java", "-jar", join(cache, artifacts[0]!.sha256 + "-saxon.jar"), `-s:${join(work, "invoices")}`, `-xsl:${join(cache, artifacts[1]!.sha256 + "-cii.xslt")}`, `-o:${join(work, "reports")}`], { stdout: "inherit", stderr: "inherit" });
  if (await java.exited !== 0) throw new Error("Saxon failed");
  const sepaFile = unwrap(sepa.serialize(sepaExample));
  unwrap(await validateSepaXml(new TextDecoder().decode(sepaFile.bytes)));
  await Bun.write(join(work, "sepa.xml"), sepaFile.bytes);
  await Bun.write(join(work, "datev.csv"), unwrap(datev.serialize(datevExample)).bytes);
  // DATEV XSDs come from the pinned DATEV URL, never from this repository.
  const schemas = await loadDatevXmlSchemas(join(await ensureDatevXmlFixtures(), "xsd"));
  await Bun.write(join(work, "datev-xml-example.zip"), unwrap(await createDatevXmlPackage(datevXmlExample, { schemas })).bytes);
  const volume = { ...datevXmlExample, documents: Array.from({ length: 300 }, (_, i) => ({
    kind: "cashLedger" as const, period: "2026-10", cashRegister: { accountNumber: "1000" }, documentDate: "2026-10-31",
    lines: [{ amount: `${i + 1}.00`, text: `Einnahme ${i}` }, { amount: `-${i + 1}.01`, text: "Ausgabe", taxRate: "19.00" }],
    files: [{ name: `bon-${i}.pdf`, bytes: samplePdf(String(i)) }],
  })) };
  await Bun.write(join(work, "datev-xml-volume.zip"), unwrap(await createDatevXmlPackage(volume, { schemas })).bytes);
  const python = Bun.spawn(["python3", new URL("./finance-conformance.py", import.meta.url).pathname, work], { stdout: "inherit", stderr: "inherit" });
  if (await python.exited !== 0) throw new Error("Independent finance checks failed");
} finally {
  await rm(work, { recursive: true, force: true });
}
