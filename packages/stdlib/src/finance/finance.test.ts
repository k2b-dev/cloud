import { validateSepaXml } from "./validate";
import { expect, test } from "bun:test";
import { datev, sepa } from "./index";
import { unwrap } from "../result";
import { datevExample, sepaExample, financeExample } from "../../examples/finance";

test("examples contain multiple postings and transfers", async () => {
  expect(await financeExample()).toEqual({ datevRows: 2, debitTotal: "123.45", creditTotal: "3.00",
    sepaRows: 2, total: "12.31" });
});

test("explicit formats, currencies and canonical caller timestamps", async () => {
  for (const patch of [{ format: undefined }, { format: "next" }, { currency: "USD" }, { currency: undefined },
    { createdAt: undefined }, { createdAt: "invalid" }, { createdAt: "2026-09-11T12:34:56.1234Z" },
    { createdAt: "2026-09-11T12:34:56.000+02:00" }]) {
    expect(datev.validate({ ...datevExample, ...patch }).ok).toBe(false);
    expect(sepa.validate({ ...sepaExample, ...patch }).ok).toBe(false);
  }
  expect(datev.validate({ ...datevExample, createdAt: "2100-01-01T00:00:00.000Z" }).ok).toBe(false);
  const before = structuredClone(sepaExample);
  const first = unwrap(sepa.serialize(before));
  expect(unwrap(sepa.serialize(before)).bytes).toEqual(first.bytes);
  expect(before).toEqual(sepaExample);
  expect(new TextDecoder().decode(first.bytes)).toContain(`<CreDtTm>${sepaExample.createdAt}</CreDtTm>`);
});

test("stable structured errors identify exact input fields and rows", () => {
  const result = sepa.validate({ ...sepaExample, rows: [sepaExample.rows[0], { ...sepaExample.rows[1], amount: 0.01, currency: "USD" }] });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected invalid input");
  expect(result.error.code).toBe("BAD_INPUT");
  expect(result.error.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "invalid_input", path: ["rows", 1, "amount"] }),
    expect.objectContaining({ code: "invalid_input", path: ["rows", 1, "currency"] }),
  ]));
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test("trailing line breaks in numeric and identifier fields are rejected before serialization", async () => {
  for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    const csv = { ...datevExample, rows: [{ ...datevExample.rows[0]!, amount: `1.00${suffix}` }] };
    const xml = { ...sepaExample, messageId: `batch${suffix}` };
    expect(datev.validate(csv).ok).toBe(false);
    expect(datev.serialize(csv).ok).toBe(false);
    expect(sepa.validate(xml).ok).toBe(false);
    expect((sepa.serialize(xml)).ok).toBe(false);
  }
});

test("application identities and caps are absent, exact totals can exceed safe minor units", () => {
  const row = { ...datevExample.rows[0]!, amount: "9999999999.99" };
  const rendered = unwrap(datev.serialize({ ...datevExample, rows: Array.from({ length: 10001 }, () => row) }));
  expect(rendered.debitTotal).toBe("100009999999899.99");
  expect(rendered.rowCount).toBe(10001);
  expect(rendered).not.toHaveProperty("businessCount");
  expect(datev.validate({ ...datevExample, destinationKey: "app" }).ok).toBe(false);
  expect(sepa.validate({ ...sepaExample, rows: [{ ...sepaExample.rows[0], businessId: "app" }] }).ok).toBe(false);
  const duplicate = sepa.validate({ ...sepaExample, rows: [sepaExample.rows[0], sepaExample.rows[0]] });
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.error.issues[0]?.path).toEqual(["rows", 1, "endToEndId"]);
});

test("invalid XML characters are reported at the input field; ampersands and apostrophes are escaped", async () => {
  for (const creditorName of ["a\u0000b", "a\ufffeb", "a\uffffb", "a\ud800b"]) {
    const result = sepa.serialize({ ...sepaExample, rows: [{ ...sepaExample.rows[0]!, creditorName }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues[0]?.path).toEqual(["rows", 0, "creditorName"]);
  }
  const result = unwrap(sepa.serialize({ ...sepaExample, debtorName: `A&B (C) 'E'` }));
  expect(new TextDecoder().decode(result.bytes)).toContain("A&amp;B (C) &apos;E&apos;");
});

test("local XSD gives XML locations and never loads external entities or schemas", async () => {
  const { xmlRegisterInputProvider, xmlCleanupInputProvider } = await import("libxml2-wasm");
  const requested: string[] = [];
  // Observe even attempted resolution without providing any file or network access.
  const provider = { match: (url: string) => { requested.push(url); return false; }, open: () => undefined, read: () => 0, close: () => false };
  xmlRegisterInputProvider(provider);
  try {
    const xml = new TextDecoder().decode(unwrap(sepa.serialize(sepaExample)).bytes);
    const invalid = await validateSepaXml(xml.replace('Ccy="EUR"', 'Ccy="USD"').replaceAll("><", ">\n<"));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.issues[0]).toMatchObject({ code: "schema_mismatch", path: ["xml"], line: expect.any(Number) });
    for (const text of [
      '<!DOCTYPE Document SYSTEM "https://example.invalid/evil.dtd"><Document/>',
      '<!DOCTYPE Document [<!ENTITY x SYSTEM "file:///etc/passwd">]><Document>&x;</Document>',
      '<!-- comment --><Document/>',
      '<![CDATA[<Document/>]]>',
      xml.replace("<GrpHdr>", '<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="https://example.invalid/x"/><GrpHdr>'),
    ]) expect((await validateSepaXml(text)).ok).toBe(false);
    const hinted = xml.replace('<Document xmlns=', '<Document xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09 https://example.invalid/x.xsd" xmlns=');
    expect((await validateSepaXml(hinted)).ok).toBe(true);
    expect(requested).toEqual([]);
  } finally { xmlCleanupInputProvider(); }
});


test("serialization is synchronous and has no schema-validation claim", () => {
  const result = sepa.serialize(JSON.parse(JSON.stringify(sepaExample)));
  expect(result).not.toBeInstanceOf(Promise);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.data).not.toHaveProperty("schemaSha256");
  expect(sepa).not.toHaveProperty("validateXml");
});

test("serializer boundary values and optional agents conform to the pinned XSD", async () => {
  for (const amount of ["0.01", "999999999.99"]) {
    for (const bic of [undefined, "ABNANL2A"]) {
      const batch = { ...sepaExample, debtorBic: bic, rows: [
        { ...sepaExample.rows[0]!, endToEndId: "A".repeat(35), amount,
          creditorName: "A".repeat(70), creditorBic: bic, remittance: "R".repeat(140) },
        { ...sepaExample.rows[1]!, amount },
      ] };
      const file = unwrap(sepa.serialize(batch));
      expect((await validateSepaXml(new TextDecoder().decode(file.bytes))).ok).toBe(true);
    }
  }
});

test("schema-invalid and malformed XML are Results, including concurrent checks", async () => {
  const xml = new TextDecoder().decode(unwrap(sepa.serialize(sepaExample)).bytes);
  const inputs = [xml, xml.slice(0, -4), xml.replace("<PmtMtd>TRF</PmtMtd>", "<PmtMtd>CHK</PmtMtd>"), xml];
  const results = await Promise.all(inputs.map(validateSepaXml));
  expect(results.map(result => result.ok)).toEqual([true, false, false, true]);
});


test("XML Schema year zero is rejected by the serializer without XSD validation", () => {
  for (const patch of [{ executionDate: "0000-01-01" }, { createdAt: "0000-01-01T00:00:00.000Z" }]) {
    const result = sepa.serialize({ ...sepaExample, ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues[0]?.path).toEqual([Object.keys(patch)[0]!]);
  }
});
