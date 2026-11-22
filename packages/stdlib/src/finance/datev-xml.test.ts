import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SaxesParser } from "saxes";
import { datevBeleglinkExample } from "../../examples/datev-beleglink";
import { datevXmlExample, samplePdf } from "../../examples/datev-xml";
import { datevExample } from "../../examples/finance";
import { ensureDatevXmlFixtures } from "../../scripts/datev-xml-fixtures";
import { loadDatevXmlSchemas } from "../bun";
import { unwrap } from "../result";
import {
  type DatevXmlCash,
  type DatevXmlDocument,
  type DatevXmlDocumentImage,
  type DatevXmlPackage,
  datev,
  datevXml,
  datevXmlLimits,
} from "./index";
import { createDatevXmlPackage, datevXmlSchemaSha256, datevXmlSchemaSource, validateDatevXml } from "./validate";

// DATEV's XSDs and samples are not in the repository; this fetches the pinned archives once
// into the git-ignored .cache/datev-xml/ (see scripts/datev-xml-fixtures.ts).
const datevCache = await ensureDatevXmlFixtures();
const schemas = await loadDatevXmlSchemas(join(datevCache, "xsd"));
const sample = (name: string) => Bun.file(join(datevCache, "samples", name)).text();

const fixtures = new URL("../../examples/fixtures/datev-xml/", import.meta.url);
const fixture = (path: string) => Bun.file(new URL(path, fixtures)).text();
const pdf = samplePdf("test");

const payable = (overrides: Partial<Extract<DatevXmlDocument, { kind: "accountsPayableLedger" }>> = {}): DatevXmlDocument => ({
  kind: "accountsPayableLedger",
  period: "2026-10",
  folder: "Eingangsrechnungen",
  documentDate: "2026-10-14",
  documentNumber: "ER-1",
  lines: [{ amount: "119.00", taxRate: "19.00" }],
  files: [],
  ...overrides,
});
const receivable = (overrides: Partial<Extract<DatevXmlDocument, { kind: "accountsReceivableLedger" }>> = {}): DatevXmlDocument => ({
  kind: "accountsReceivableLedger",
  period: "2026-10",
  folder: "Ausgangsrechnungen",
  documentDate: "2026-10-14",
  documentNumber: "RE-1",
  lines: [{ amount: "119.00", taxRate: "19.00" }],
  files: [],
  ...overrides,
});
const cash = (overrides: Partial<DatevXmlCash> = {}): DatevXmlDocument => ({
  kind: "cashLedger",
  period: "2026-10",
  cashRegister: { name: "Kasse" },
  documentDate: "2026-10-14",
  lines: [{ amount: "-5.00", text: "Porto" }],
  files: [],
  ...overrides,
});
const image = (overrides: Partial<DatevXmlDocumentImage> = {}): DatevXmlDocumentImage => ({
  kind: "documentImage",
  guid: "E0A08953-FBAA-4054-AF36-993D5D68F040",
  files: [{ name: "image.pdf", bytes: pdf }],
  ...overrides,
});
const pack = (documents: DatevXmlDocument[], overrides: Partial<DatevXmlPackage> = {}): DatevXmlPackage => ({
  format: "datev-xml-online-6.0",
  currency: "EUR",
  createdAt: "2026-11-02T09:15:00",
  generatorInfo: "Muster GmbH",
  documents,
  ...overrides,
});
/** Untyped input for negative tests. */
const loose = (value: unknown): never => value as never;

function issues(input: unknown) {
  const result = datevXml.serialize(loose(input));
  if (result.ok) throw new Error("Expected a failure.");
  return result.error.issues;
}
function expectIssue(input: unknown, path: (string | number)[], message?: RegExp) {
  const found = issues(input);
  const match = found.find((issue) => JSON.stringify(issue.path.slice(0, path.length)) === JSON.stringify(path));
  if (!match) throw new Error(`No issue at ${JSON.stringify(path)}: ${JSON.stringify(found)}`);
  if (message) expect(match.message).toMatch(message);
  return match;
}
async function expectSchemaValid(input: DatevXmlPackage) {
  const result = await createDatevXmlPackage(input, { schemas });
  if (!result.ok) throw new Error(JSON.stringify(result.error.issues.slice(0, 5)));
  return result.data;
}

type ZipEntry = { name: string; bytes: Uint8Array; flags: number; method: number; time: number; date: number };
/** Independent reader: EOCD → central directory → local headers; checks sizes and CRC with Bun's CRC32. */
function readZip(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  expect(cursor + view.getUint32(eocd + 12, true)).toBe(eocd);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const time = view.getUint16(cursor + 12, true);
    const date = view.getUint16(cursor + 14, true);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const local = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const bytes = zip.subarray(start, start + size);
    expect(Bun.hash.crc32(bytes)).toBe(crc);
    entries.push({ name, bytes, flags, method, time, date });
    cursor += 46 + nameLength;
  }
  return entries;
}

/** Element texts of a ledger file via an independent XML parser (round-trip of escaping). */
function texts(xml: string, name: string): string[] {
  const parser = new SaxesParser({ xmlns: true });
  const found: string[] = [];
  let current: string | undefined;
  parser.on("opentag", (tag) => {
    current = tag.local === name ? "" : undefined;
  });
  parser.on("text", (value) => {
    if (current !== undefined) current += value;
  });
  parser.on("closetag", (tag) => {
    if (tag.local === name && current !== undefined) found.push(current);
    current = undefined;
  });
  parser.write(xml).close();
  return found;
}

describe("DATEV XML-Schnittstelle online package", () => {
  test("golden document.xml, ledger files and ZIP bytes", async () => {
    const file = unwrap(datevXml.serialize(datevXmlExample));
    expect(file.documentXml).toBe(await fixture("golden/document.xml"));
    for (const document of file.documents) {
      if (document.dataFile === undefined) throw new Error("Expected a ledger document.");
      expect(document.xml).toBe(await fixture(`golden/${document.dataFile}`));
    }
    expect(new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex")).toBe(
      "f36364bb18f4a2d527879771807cd100793a7d555d94bd2cdcfc42777f99dfa7",
    );
    expect(file.documents.map((document) => [document.dataFile, document.amount, document.files])).toEqual([
      ["datev-ledger-0001.xml", "129.70", ["ER-R-2026-0815.pdf"]],
      ["datev-ledger-0002.xml", "-50.00", ["RE2026-00012.pdf"]],
      ["datev-ledger-0003.xml", "-23.80", ["KB-0042.pdf"]],
    ]);
    expect(file.lineCount).toBe(4);
  });

  test("ZIP is stored, ASCII, ordered, timestamped and byte-identical to the inputs", () => {
    const file = unwrap(datevXml.serialize(datevXmlExample));
    const entries = readZip(file.bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      "document.xml",
      "datev-ledger-0001.xml",
      "ER-R-2026-0815.pdf",
      "datev-ledger-0002.xml",
      "RE2026-00012.pdf",
      "datev-ledger-0003.xml",
      "KB-0042.pdf",
    ]);
    for (const entry of entries) {
      expect(entry.method).toBe(0);
      expect(entry.flags).toBe(0);
      // 2026-11-02 09:15:00 as MS-DOS date and time.
      expect(entry.date).toBe(((2026 - 1980) << 9) | (11 << 5) | 2);
      expect(entry.time).toBe((9 << 11) | (15 << 5));
    }
    expect(new TextDecoder().decode(entries[0]!.bytes)).toBe(file.documentXml);
    expect(entries[2]!.bytes).toEqual(datevXmlExample.documents[0]!.files[0]!.bytes);
  });

  test("every document kind passes the pinned DATEV XSD", async () => {
    const file = await expectSchemaValid(datevXmlExample);
    expect(file.documents).toHaveLength(3);
    for (const document of [payable(), receivable(), cash(), cash({ cashRegister: { accountNumber: "1000" } })])
      await expectSchemaValid(pack([document]));
  });

  test("file-only documents pass the official XSD without any ledger file", async () => {
    for (const guid of [image().guid, image().guid.toLowerCase()]) {
      const document = image({
        guid,
        files: [
          { name: "image.pdf", bytes: pdf },
          { name: "appendix.pdf", bytes: pdf },
        ],
      });
      const file = await expectSchemaValid(pack([document]));
      expect(file.lineCount).toBe(0);
      expect(file.documents).toEqual([{ files: ["image.pdf", "appendix.pdf"] }]);
      expect(file.documentXml).toContain(`<document guid="${guid}">`);
      expect(file.documentXml).toContain('<extension xsi:type="File" name="image.pdf"/>');
      expect(file.documentXml).not.toContain("Ledger");
      expect(file.documentXml).not.toContain("datafile=");
      expect(file.documentXml).not.toContain("<property");
      expect(file.documentXml).not.toContain("processID=");
      const entries = readZip(file.bytes);
      expect(entries.map((entry) => entry.name)).toEqual(["document.xml", "image.pdf", "appendix.pdf"]);
      expect(entries[1]!.bytes).toEqual(pdf);
      expect(entries[2]!.bytes).toEqual(pdf);
      expect(unwrap(datevXml.serialize(pack([document]))).bytes).toEqual(file.bytes);
    }
  });

  test("mixed image and ledger documents retain order, numbering and booking totals", async () => {
    const file = await expectSchemaValid(pack([image(), cash({ files: [{ name: "cash.pdf", bytes: pdf }] })]));
    const ledger = file.documents[1]!;
    if (ledger.dataFile === undefined) throw new Error("Expected a ledger data file.");
    expect(file.documents).toEqual([
      { files: ["image.pdf"] },
      {
        dataFile: "datev-ledger-0002.xml",
        xml: ledger.xml,
        amount: "-5.00",
        files: ["cash.pdf"],
      },
    ]);
    expect(file.lineCount).toBe(1);
    expect(readZip(file.bytes).map((entry) => entry.name)).toEqual(["document.xml", "image.pdf", "datev-ledger-0002.xml", "cash.pdf"]);
  });

  test("requires guid and files for document images, rejects ledger fields", async () => {
    const { guid, ...withoutGuid } = image();
    expectIssue(pack([loose(withoutGuid)]), ["documents", 0, "guid"]);
    expectIssue(pack([image({ files: [] })]), ["documents", 0, "files"]);
    for (const invalidGuid of ["", "no-guid", `{${guid}}`, guid.replaceAll("-", ""), `${guid}\n`])
      expectIssue(pack([image({ guid: invalidGuid })]), ["documents", 0, "guid"]);
    expect(datevXml.validate(pack([loose({ ...image(), lines: [{ amount: "1.00" }] })])).ok).toBe(false);
    const checked = await createDatevXmlPackage(pack([loose(withoutGuid)]), { schemas });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.issues[0]!.path).toEqual(["documents", 0, "guid"]);
  });

  test("image documents share GUID, filename and file validation with ledger documents", () => {
    expectIssue(
      pack([image(), payable({ guid: image().guid.toLowerCase(), files: [{ name: "other.pdf", bytes: pdf }] })]),
      ["documents", 1, "guid"],
      /Duplicate GUID/,
    );
    expectIssue(
      pack([image(), cash({ files: [{ name: "IMAGE.pdf", bytes: pdf }] })]),
      ["documents", 1, "files", 0, "name"],
      /Duplicate file/,
    );
    expectIssue(pack([image({ files: [{ name: "image.pdf", bytes: new Uint8Array([1]) }] })]), ["documents", 0, "files", 0, "bytes"]);
    expectIssue(
      pack([
        image({ files: Array.from({ length: datevXmlLimits.filesPerDocument + 1 }, (_, i) => ({ name: `image-${i}.pdf`, bytes: pdf })) }),
      ]),
      ["documents", 0, "files"],
    );
  });

  test("the booking link uses exactly the GUID written to the image document", async () => {
    const document = image();
    const file = await expectSchemaValid(pack([document]));
    const csv = unwrap(
      datev.serialize({ ...datevExample, rows: [{ ...datevExample.rows[0]!, text: "Rent", documentGuid: document.guid }] }),
    );
    expect(new TextDecoder().decode(csv.bytes).split("\r\n")[2]!.split(";")[19]).toBe(`"BEDI ""${document.guid}"""`);
    expect(file.documentXml).toContain(`<document guid="${document.guid}">`);
  });

  test("the combined public example produces a checked image ZIP and matching CSV link", async () => {
    const result = await datevBeleglinkExample(pdf, schemas);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const entries = readZip(result.data.imageZip);
    expect(entries.map((entry) => entry.name)).toEqual(["document.xml", "RE-2026-1.pdf"]);
    expect(new TextDecoder().decode(entries[0]!.bytes)).toContain(`<document guid="${image().guid}">`);
    expect(new TextDecoder().decode(result.data.bookingCsv).split("\r\n")[2]).toContain(`;"BEDI ""${image().guid}""";`);
  });

  test("serialization is deterministic and does not mutate inputs", () => {
    const input = structuredClone(datevXmlExample);
    const before = JSON.stringify(input, (_, value) => (value instanceof Uint8Array ? Array.from(value) : value));
    const first = unwrap(datevXml.serialize(input)).bytes;
    expect(unwrap(datevXml.serialize(input)).bytes).toEqual(first);
    expect(JSON.stringify(input, (_, value) => (value instanceof Uint8Array ? Array.from(value) : value))).toBe(before);
    expect(unwrap(datevXml.validate(input))).toEqual(input);
  });

  test("cash register uses key 2 for an account number and key 3 for a name", () => {
    expect(unwrap(datevXml.serialize(pack([cash({ cashRegister: { accountNumber: "1000" } })]))).documentXml).toContain(
      '<property key="2" value="1000"/>',
    );
    expect(unwrap(datevXml.serialize(pack([cash()]))).documentXml).toContain('<property key="3" value="Kasse"/>');
    expectIssue(pack([loose(cash({ cashRegister: loose({ accountNumber: "1000", name: "Kasse" }) }))]), ["documents", 0, "cashRegister"]);
    expectIssue(pack([loose(cash({ cashRegister: loose({}) }))]), ["documents", 0, "cashRegister"]);
    expectIssue(pack([cash({ cashRegister: { accountNumber: "01000" } })]), ["documents", 0, "cashRegister"]);
  });
});

describe("amounts and signs", () => {
  test("credits are negative invoices; mixed signs within an invoice fail", async () => {
    await expectSchemaValid(
      pack([
        payable({ lines: [{ amount: "-10.00" }, { amount: "-5.35", taxRate: "7.00" }] }),
        receivable({ lines: [{ amount: "-1.00" }] }),
      ]),
    );
    expectIssue(
      pack([payable({ lines: [{ amount: "10.00" }, { amount: "-1.00" }] })]),
      ["documents", 0, "lines", 1, "amount"],
      /same sign/,
    );
    expectIssue(
      pack([receivable({ lines: [{ amount: "-10.00" }, { amount: "1.00" }] })]),
      ["documents", 0, "lines", 1, "amount"],
      /same sign/,
    );
  });

  test("zero and malformed amounts fail with field paths", () => {
    for (const amount of ["0.00", "-0.00", "12.3", "12.300", "+1.00", "01.00", "1e2", "1,00", "10000000000.00", " 1.00"])
      expectIssue(pack([payable({ lines: [{ amount }] })]), ["documents", 0, "lines", 0, "amount"]);
    expectIssue(pack([payable({ lines: [{ amount: loose(12.3) }] })]), ["documents", 0, "lines", 0, "amount"]);
  });

  test("cash lines may mix signs and net to zero", async () => {
    const file = await expectSchemaValid(
      pack([
        cash({
          lines: [
            { amount: "100.00", text: "Einlage" },
            { amount: "-100.00", text: "Bank" },
          ],
        }),
      ]),
    );
    expect(file.documents[0]!.amount).toBe("0.00");
    expect(file.documents[0]!.xml).toContain('consolidatedAmount="0.00"');
  });

  test("several tax rates sum exactly", async () => {
    const lines = ["19.00", "7.00", "0.00", "16.00", "5.00"].map((taxRate, i) => ({ amount: `${i + 1}0.01`, taxRate }));
    const file = await expectSchemaValid(pack([payable({ lines })]));
    expect(file.documents[0]!.amount).toBe("150.05");
    expect(texts(file.documents[0]!.xml!, "tax")).toEqual(["19.00", "7.00", "0.00", "16.00", "5.00"]);
    for (const taxRate of ["19", "19.0", "100.00", "-7.00", "7,00"])
      expectIssue(pack([payable({ lines: [{ amount: "1.00", taxRate }] })]), ["documents", 0, "lines", 0, "taxRate"]);
  });

  test("the consolidated amount must stay within DATEV's range", async () => {
    const max = { amount: "9999999999.99" };
    await expectSchemaValid(
      pack([
        payable({ lines: [max] }),
        cash({
          lines: [
            { ...max, text: "a" },
            { amount: "-9999999999.99", text: "b" },
          ],
        }),
      ]),
    );
    const overflow = pack([payable({ lines: [max, { amount: "0.01" }] })]);
    const failure = expectIssue(overflow, ["documents", 0, "lines"], /consolidated/);
    expect(failure.code).toBe("input_limit");
    const validated = datevXml.validate(overflow);
    expect(!validated.ok && validated.error.issues[0]!.code).toBe("input_limit");
  });
});

describe("text, characters and lengths", () => {
  test("German umlauts and XML-special characters are escaped and round-trip", async () => {
    const special = `Müller & Söhne <"Ä">`;
    const file = await expectSchemaValid(
      pack([
        payable({
          partyName: special,
          partyCity: "Großröhrsdorf",
          lines: [
            {
              amount: "1.00",
              text: "Öl 'ß' § € °",
              information: "Straße # | ` ´ ^ % * ~ : ; . - / + = _ ? $ ! { } [ ] , ( ) \\ 漢字 한국",
            },
          ],
        }),
      ]),
    );
    const xml = file.documents[0]!.xml!;
    expect(xml).toContain("Müller &amp; Söhne &lt;&quot;Ä&quot;&gt;");
    expect(texts(xml, "supplierName")).toEqual([special]);
    expect(texts(xml, "bookingText")).toEqual(["Öl 'ß' § € °"]);
  });

  test("characters outside DATEV's repertoire fail instead of being replaced", () => {
    for (const value of ["„Zitat“", "A – B", "Łódź", "😀", "Œuvre", "Tab\there", "Zeile\nzwei", "\u0085", "​"])
      expectIssue(pack([payable({ partyName: value })]), ["documents", 0, "partyName"], /character set/);
  });

  test("decomposed Unicode asks for NFC", () => {
    expectIssue(pack([payable({ partyName: "Müller" })]), ["documents", 0, "partyName"], /NFC/);
  });

  test("blank and padded values fail", () => {
    for (const value of ["", " ", " Kasse", "Kasse ", " Kasse"])
      expectIssue(pack([cash({ cashRegister: { name: value } })]), ["documents", 0, "cashRegister"]);
    expectIssue(pack([payable({ folder: " Eingang" })]), ["documents", 0, "folder"], /whitespace/);
  });

  test("maximum lengths pass the XSD; one more character fails", async () => {
    const at = (n: number) => "ä".repeat(n);
    await expectSchemaValid(
      pack(
        [
          payable({
            folder: at(40),
            partyName: at(50),
            partyCity: at(30),
            partyId: at(15),
            documentNumber: "A".repeat(36),
            lines: [{ amount: "1.00", text: at(30), information: at(120), costCenter1: "K".repeat(36), costCenter2: "a b" }],
          }),
          cash({ cashRegister: { name: at(40) }, lines: [{ amount: "1.00", text: at(30), documentNumber: "9".repeat(36) }] }),
        ],
        { generatorInfo: at(40), generatingSystem: at(40), description: at(255) },
      ),
    );
    const cases: [DatevXmlPackage, (string | number)[]][] = [
      [pack([payable({ folder: at(41) })]), ["documents", 0, "folder"]],
      [pack([payable({ partyName: at(51) })]), ["documents", 0, "partyName"]],
      [pack([payable({ partyCity: at(31) })]), ["documents", 0, "partyCity"]],
      [pack([payable({ partyId: at(16) })]), ["documents", 0, "partyId"]],
      [pack([payable({ documentNumber: "A".repeat(37) })]), ["documents", 0, "documentNumber"]],
      [pack([payable({ lines: [{ amount: "1.00", text: at(31) }] })]), ["documents", 0, "lines", 0, "text"]],
      [pack([payable({ lines: [{ amount: "1.00", information: at(121) }] })]), ["documents", 0, "lines", 0, "information"]],
      [pack([payable({ lines: [{ amount: "1.00", costCenter1: "K".repeat(37) }] })]), ["documents", 0, "lines", 0, "costCenter1"]],
      [pack([cash({ lines: [{ amount: "1.00", text: at(31) }] })]), ["documents", 0, "lines", 0, "text"]],
      [pack([payable()], { generatorInfo: at(41) }), ["generatorInfo"]],
      [pack([payable()], { description: at(256) }), ["description"]],
    ];
    for (const [input, path] of cases) expectIssue(input, path);
  });

  test("document numbers follow the DATEV invoiceId pattern", () => {
    for (const documentNumber of ["RE_1", "RE 1", "RE.1", "RÄ-1", ""])
      expectIssue(pack([payable({ documentNumber })]), ["documents", 0, "documentNumber"]);
  });
});

describe("required fields, dates and identifiers", () => {
  test("missing required fields are reported by path", () => {
    const { folder: _folder, ...withoutFolder } = payable() as Extract<DatevXmlDocument, { kind: "accountsPayableLedger" }>;
    expectIssue(pack([loose(withoutFolder)]), ["documents", 0, "folder"]);
    const { documentNumber: _number, ...withoutNumber } = receivable() as Extract<DatevXmlDocument, { kind: "accountsReceivableLedger" }>;
    expectIssue(pack([loose(withoutNumber)]), ["documents", 0, "documentNumber"]);
    expectIssue(pack([cash({ lines: [loose({ amount: "1.00" })] })]), ["documents", 0, "lines", 0, "text"]);
    expectIssue(pack([payable({ lines: [] })]), ["documents", 0, "lines"]);
    expectIssue(pack([]), ["documents"]);
    expectIssue({ ...pack([payable()]), generatorInfo: undefined }, ["generatorInfo"]);
    expectIssue({ ...pack([payable()]), currency: "USD" }, ["currency"]);
    expectIssue({ ...pack([payable()]), format: "datev-xml-online-5.0" }, ["format"]);
    expectIssue(pack([loose({ ...payable(), kind: "invoice" })]), ["documents", 0, "kind"]);
    expectIssue(pack([loose({ ...payable(), orderId: "1" })]), ["documents", 0, "orderId"]);
    expectIssue({ ...pack([payable()]), consultantNumber: "1001" }, ["consultantNumber"]);
  });

  test("dates must fit the period and DATEV's ordering rules", () => {
    expectIssue(pack([payable({ documentDate: "2026-11-01" })]), ["documents", 0, "documentDate"], /period/);
    expectIssue(pack([payable({ dueDate: "2026-10-13" })]), ["documents", 0, "dueDate"]);
    expectIssue(pack([payable({ deliveryDate: "2026-10-15" })]), ["documents", 0, "deliveryDate"], /ignores/);
    expectIssue(pack([payable({ documentDate: "2026-02-30", period: "2026-02" })]), ["documents", 0, "documentDate"]);
    expectIssue(pack([payable({ period: "2026-13" })]), ["documents", 0, "period"]);
    expectIssue(pack([payable({ period: "1999-12", documentDate: "1999-12-01" })]), ["documents", 0, "period"]);
    for (const createdAt of [
      "2026-11-02T09:15:00Z",
      "2026-11-02T09:15:00.000",
      "2026-11-02 09:15:00",
      "2026-11-31T09:15:00",
      "2026-11-02T24:00:00",
    ])
      expectIssue(pack([payable()], { createdAt }), ["createdAt"]);
  });

  test("GUIDs need a file and must be unique", async () => {
    const guid = "9FFD1116-DA0C-4A30-95D4-EF93FE31097A";
    const file = await expectSchemaValid(pack([cash({ guid, files: [{ name: "bon.pdf", bytes: pdf }] })]));
    expect(file.documentXml).toContain(`<document guid="${guid}">`);
    expectIssue(pack([cash({ guid })]), ["documents", 0, "guid"], /file/);
    expectIssue(
      pack([
        payable({ guid, files: [{ name: "a.pdf", bytes: pdf }] }),
        payable({ guid: guid.toLowerCase(), files: [{ name: "b.pdf", bytes: pdf }] }),
      ]),
      ["documents", 1, "guid"],
      /Duplicate/,
    );
    expectIssue(pack([payable({ guid: "not-a-guid", files: [{ name: "a.pdf", bytes: pdf }] })]), ["documents", 0, "guid"]);
  });

  test("accounts, BU keys, IBAN, BIC and VAT IDs are checked", async () => {
    await expectSchemaValid(
      pack([
        payable({
          partyAccount: "70000",
          iban: "DE89370400440532013000",
          bic: "COBADEFFXXX",
          vatId: "DE123456789",
          partyId: "K-1",
          paidAt: "2026-10-15",
          lines: [{ amount: "1.00", account: "3400", buCode: "401", costCenter1: "100" }],
        }),
      ]),
    );
    expectIssue(pack([payable({ lines: [{ amount: "1.00", account: "0440" }] })]), ["documents", 0, "lines", 0, "account"]);
    expectIssue(pack([payable({ lines: [{ amount: "1.00", buCode: "0009" }] })]), ["documents", 0, "lines", 0, "buCode"]);
    expectIssue(pack([payable({ lines: [{ amount: "1.00", buCode: "10000" }] })]), ["documents", 0, "lines", 0, "buCode"]);
    expectIssue(pack([payable({ partyAccount: "9999" })]), ["documents", 0, "partyAccount"]);
    expectIssue(pack([payable({ partyAccount: "10000" })]), ["documents", 0, "partyAccount"], /creditor/);
    expectIssue(pack([receivable({ partyAccount: "999999999" })]), ["documents", 0, "partyAccount"], /debtor/);
    await expectSchemaValid(pack([receivable({ partyAccount: "10000" }), payable({ partyAccount: "999999999" })]));
    for (let digits = 5; digits <= 9; digits++) {
      for (const first of ["1", "6", "7", "9"]) {
        const account = first + "0".repeat(digits - 1);
        const creditor = first >= "7";
        expect(datevXml.validate(pack([payable({ partyAccount: account })])).ok).toBe(creditor);
        expect(datevXml.validate(pack([receivable({ partyAccount: account })])).ok).toBe(!creditor);
      }
    }
    expectIssue(pack([payable({ iban: "DE89370400440532013001" })]), ["documents", 0, "iban"]);
    expectIssue(pack([payable({ iban: "DE89 3704 0044 0532 0130 00" })]), ["documents", 0, "iban"]);
    expectIssue(pack([payable({ bic: "cobadeff" })]), ["documents", 0, "bic"]);
    expectIssue(pack([payable({ vatId: "DE 123456789" })]), ["documents", 0, "vatId"]);
  });
});

describe("files", () => {
  test("file names must be ASCII, typed, unique and not reserved", () => {
    const bad = [
      "Rechnung Müller.pdf",
      "Rechnung 1.pdf",
      "../a.pdf",
      "a/b.pdf",
      "a.exe",
      "a",
      ".pdf",
      "-a.pdf",
      "CON.pdf",
      "document.xml",
      "DOCUMENT.XML",
      "a".repeat(97) + ".pdf",
    ];
    for (const name of bad) expectIssue(pack([payable({ files: [{ name, bytes: pdf }] })]), ["documents", 0, "files", 0, "name"]);
    expectIssue(
      pack([payable({ files: [{ name: "a.pdf", bytes: pdf }] }), cash({ files: [{ name: "A.PDF", bytes: pdf }] })]),
      ["documents", 1, "files", 0, "name"],
      /Duplicate/,
    );
    expectIssue(
      pack([
        payable({
          files: [
            { name: "a.pdf", bytes: pdf },
            { name: "a.pdf", bytes: pdf },
          ],
        }),
      ]),
      ["documents", 0, "files", 1, "name"],
      /Duplicate/,
    );
    expectIssue(
      pack([payable({ files: [{ name: "datev-ledger-0001.xml", bytes: new TextEncoder().encode("<x/>") }] })]),
      ["documents", 0, "files", 0, "name"],
      /reserved/,
    );
  });

  test("file bytes are checked for presence, size and type", () => {
    expectIssue(pack([payable({ files: [{ name: "a.pdf", bytes: new Uint8Array() }] })]), ["documents", 0, "files", 0, "bytes"], /Empty/);
    expectIssue(
      pack([payable({ files: [{ name: "a.pdf", bytes: new TextEncoder().encode("<html>") }] })]),
      ["documents", 0, "files", 0, "bytes"],
      /PDF/,
    );
    expectIssue(pack([payable({ files: [{ name: "a.png", bytes: pdf }] })]), ["documents", 0, "files", 0, "bytes"], /PNG/);
    expectIssue(pack([payable({ files: [{ name: "a.pdf", bytes: loose("text") }] })]), ["documents", 0, "files", 0, "bytes"]);
    const big = new Uint8Array(datevXmlLimits.fileBytes + 1);
    big.set(pdf);
    expectIssue(pack([payable({ files: [{ name: "a.pdf", bytes: big }] })]), ["documents", 0, "files", 0, "bytes"], /20 MB/);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
    expect(
      datevXml.serialize(
        pack([
          payable({
            files: [
              { name: "a.jpg", bytes: jpeg },
              { name: "b.txt", bytes: new TextEncoder().encode("Notiz") },
            ],
          }),
        ]),
      ).ok,
    ).toBe(true);
  });

  test("a document holds at most 49 files and the package at most 465 MB", () => {
    const files = Array.from({ length: 50 }, (_, i) => ({ name: `f${i}.pdf`, bytes: pdf }));
    expectIssue(pack([payable({ files })]), ["documents", 0, "files"]);
    expect(datevXml.serialize(pack([payable({ files: files.slice(0, 49) })])).ok).toBe(true);
    // 24 views of one 19.5 MB buffer: 468 MB of input without allocating it.
    const buffer = new Uint8Array(19_500_000);
    buffer.set(pdf);
    const documents = Array.from({ length: 24 }, (_, i) =>
      payable({ documentNumber: `ER-${i}`, files: [{ name: `big${i}.pdf`, bytes: buffer.subarray(0) }] }),
    );
    expectIssue(pack(documents), ["documents"], /465 MB/);
    // Attachments alone fit; document.xml, ledger files and ZIP headers push the package over the limit.
    const edge = new Uint8Array(19_375_000);
    edge.set(pdf);
    const tight = pack(
      Array.from({ length: 24 }, (_, i) => payable({ documentNumber: `ER-${i}`, files: [{ name: `e${i}.pdf`, bytes: edge.subarray(0) }] })),
    );
    expect(24 * edge.byteLength).toBeLessThanOrEqual(datevXmlLimits.packageBytes);
    const validated = datevXml.validate(tight);
    expect(!validated.ok && validated.error.issues[0]!.message).toMatch(/465 MB/);
  });
});

describe("volume", () => {
  test("4999 documents and 5000 lines are accepted; one more fails", async () => {
    const many = Array.from({ length: datevXmlLimits.documents }, (_, i) => cash({ lines: [{ amount: "1.00", text: `Bon ${i}` }] }));
    const file = unwrap(datevXml.serialize(pack(many)));
    expect(file.documents).toHaveLength(4999);
    expect(file.documents.at(-1)!.dataFile).toBe("datev-ledger-4999.xml");
    unwrap(await validateDatevXml(file.documentXml, { schema: "document", schemas }));
    expectIssue(pack([...many, cash()]), ["documents"]);
    const lines = Array.from({ length: datevXmlLimits.lines }, (_, i) => ({ amount: "0.01", text: `Zeile ${i}` }));
    const large = await expectSchemaValid(pack([cash({ lines })]));
    expect(large.documents[0]!.amount).toBe("50.00");
    expectIssue(pack([cash({ lines: [...lines, lines[0]!] })]), ["documents", 0, "lines"]);
  }, 60_000);
});

describe("XSD validation entry point", () => {
  test("DATEV's own sample files validate unchanged", async () => {
    for (const [name, schema] of [
      ["ER_document.xml", "document"],
      ["Kasse_einzelDateien_document.xml", "document"],
      ["ER_Rechnungsdaten_RE_R2023x204.xml", "ledger"],
      ["ERK_Rechnungskorrekturdaten_REK_RK2023x101.xml", "ledger"],
      ["AR_Rechnungsdaten_RA_R-2023-204.xml", "ledger"],
      ["Kasse_12Januar2023.xml", "ledger"],
    ] as const)
      unwrap(await validateDatevXml(await sample(name), { schema, schemas }));
  });

  test("schema violations are reported with locations", async () => {
    const ledger = await fixture("golden/datev-ledger-0003.xml");
    for (const broken of [
      ledger.replace("<amount>-23.80</amount>", "<amount>0.00</amount>"),
      ledger.replace("<bookingText>Porto</bookingText>", ""),
      ledger.replace("<tax>19.00</tax>", "<tax>19</tax>"),
      ledger.replace("<currencyCode>EUR</currencyCode>", "<currencyCode>USD</currencyCode>"),
      ledger.replace(/<tax>19.00<\/tax>\n(\s*)<information>(.*?)<\/information>/, "<information>$2</information>\n$1<tax>19.00</tax>"),
    ]) {
      expect(broken).not.toBe(ledger);
      const result = await validateDatevXml(broken, { schema: "ledger", schemas });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("BAD_INPUT");
        expect(result.error.issues[0]).toMatchObject({ code: "schema_mismatch", path: ["xml"] });
        expect(result.error.issues[0]!.line).toBeGreaterThan(0);
      }
    }
    const document = await fixture("golden/document.xml");
    expect((await validateDatevXml(document, { schema: "ledger", schemas })).ok).toBe(false);
    expect((await validateDatevXml(ledger, { schema: "document", schemas })).ok).toBe(false);
    expect(
      (await validateDatevXml(document.replace('key="1" value="2026-10"', 'key="4" value="2026-10"'), { schema: "document", schemas })).ok,
    ).toBe(false);
  });

  test("DTDs, CDATA, malformed XML and unknown schema names fail safely", async () => {
    const ledger = await fixture("golden/datev-ledger-0003.xml");
    const doctype = await validateDatevXml(`<!DOCTYPE x [<!ENTITY a "b">]>${ledger.slice(ledger.indexOf("<LedgerImport"))}`, {
      schema: "ledger",
      schemas,
    });
    expect(!doctype.ok && doctype.error.issues[0]!.code).toBe("invalid_xml");
    const cdata = await validateDatevXml(ledger.replace("Porto", "<![CDATA[Porto]]>"), { schema: "ledger", schemas });
    expect(!cdata.ok && cdata.error.issues[0]!.code).toBe("invalid_xml");
    const malformed = await validateDatevXml("<LedgerImport", { schema: "ledger", schemas });
    expect(!malformed.ok && malformed.error.issues[0]!.code).toBe("invalid_xml");
    const schema = await validateDatevXml(ledger, loose({ schema: "invoice", schemas }));
    expect(!schema.ok && schema.error.issues[0]!.path).toEqual(["options", "schema"]);
  });

  test("createDatevXmlPackage returns no bytes for invalid input", async () => {
    const result = await createDatevXmlPackage(pack([payable({ lines: [{ amount: "0.00" }] })]), { schemas });
    expect(!result.ok && result.error.code).toBe("BAD_INPUT");
  });

  test("missing or altered schemas are INTERNAL and never skip the check", async () => {
    expect(Object.values(datevXmlSchemaSha256).every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    const ledger = await fixture("golden/datev-ledger-0003.xml");
    const { "Document_types_v060.xsd": _types, ...incomplete } = schemas;
    const tampered = {
      ...schemas,
      "Belegverwaltung_online_ledger_types_v060.xsd": schemas["Belegverwaltung_online_ledger_types_v060.xsd"]!.replace(
        "9999999999.99",
        "99999999999.99",
      ),
    };
    for (const [given, code, path] of [
      [undefined, "validator_unavailable", ["schemas", "Document_v060.xsd"]],
      [{}, "validator_unavailable", ["schemas", "Document_v060.xsd"]],
      [incomplete, "validator_unavailable", ["schemas", "Document_types_v060.xsd"]],
      [tampered, "schema_integrity", ["schemas", "Belegverwaltung_online_ledger_types_v060.xsd"]],
      [
        { ...schemas, "Document_v060.xsd": schemas["Document_v060.xsd"]!.replaceAll("\r\n", "\n") },
        "schema_integrity",
        ["schemas", "Document_v060.xsd"],
      ],
    ] as const) {
      for (const result of [
        await createDatevXmlPackage(datevXmlExample, loose({ schemas: given })),
        await validateDatevXml(ledger, loose({ schema: "ledger", schemas: given })),
      ]) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("INTERNAL");
          expect(result.error.issues[0]).toMatchObject({ code, path });
          if (code === "validator_unavailable") expect(result.error.issues[0]!.message).toContain(datevXmlSchemaSource.url);
        }
      }
    }
    expect((await createDatevXmlPackage(datevXmlExample, loose(undefined))).ok).toBe(false);
    // Extra files from DATEV's archive are ignored.
    unwrap(await createDatevXmlPackage(datevXmlExample, { schemas: { ...schemas, "Belegverwaltung_online_invoice_v060.xsd": "<x/>" } }));
  });

  // Fresh processes, because the validator caches its compiled schemas per module. They start
  // without the runner's BUN_OPTIONS: a preload that already loaded zod or saxes would hide the
  // missing-peer case below (Cloud's test-infra preload loads zod once CLOUD_TEST_* is set).
  const isolated = async (source: string) => {
    const { BUN_OPTIONS: _runnerOptions, ...env } = process.env;
    const child = Bun.spawn(["bun", "-e", source], {
      cwd: new URL("../..", import.meta.url).pathname,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(errors);
    return output.trim();
  };

  test("schemas stay usable after another consumer resets the input providers", async () => {
    expect(
      await isolated(`
      const { xmlCleanupInputProvider } = await import("libxml2-wasm");
      const { validateDatevXml, createDatevXmlPackage } = await import("./src/finance/validate.ts");
      const { loadDatevXmlSchemas } = await import("./src/bun/index.ts");
      const { datevXmlExample } = await import("./examples/datev-xml.ts");
      const schemas = await loadDatevXmlSchemas(${JSON.stringify(join(datevCache, "xsd"))});
      const first = await validateDatevXml(await Bun.file("examples/fixtures/datev-xml/golden/document.xml").text(), { schema: "document", schemas });
      xmlCleanupInputProvider();
      const second = await createDatevXmlPackage(datevXmlExample, { schemas });
      console.log(first.ok && second.ok ? "ok" : JSON.stringify(second));
    `),
    ).toBe("ok");
  });

  test("an unavailable validator is a structured INTERNAL result, never a rejection", async () => {
    expect(
      await isolated(`
      const { loadDatevXmlSchemas } = await import("./src/bun/index.ts");
      const schemas = await loadDatevXmlSchemas(${JSON.stringify(join(datevCache, "xsd"))});
      Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
      const { validateDatevXml, createDatevXmlPackage } = await import("./src/finance/validate.ts");
      const { datevXmlExample } = await import("./examples/datev-xml.ts");
      const results = [await createDatevXmlPackage(datevXmlExample, { schemas }), await validateDatevXml("<archive/>", { schema: "document", schemas })];
      console.log(results.map(r => !r.ok && r.error.code + ":" + r.error.issues[0].code).join(","));
    `),
    ).toBe("INTERNAL:validator_unavailable,INTERNAL:validator_unavailable");
  });

  test("missing peer dependencies are validator_unavailable, also for invoices", async () => {
    // A runtime plugin makes the peers unresolvable, as in an install without them.
    expect(
      await isolated(`
      const { loadDatevXmlSchemas } = await import("./src/bun/index.ts");
      const schemas = await loadDatevXmlSchemas(${JSON.stringify(join(datevCache, "xsd"))});
      Bun.plugin({ name: "missing-peers", setup(build) {
        build.onLoad({ filter: /node_modules\\/(zod|saxes)\\// }, () => { throw new Error("missing peer"); });
      } });
      const { createDatevXmlPackage, validateInvoiceXml } = await import("./src/finance/validate.ts");
      const input = ${JSON.stringify(pack([cash()]))};
      const results = [
        await createDatevXmlPackage(input, { schemas }),
        await validateInvoiceXml("<x/>", { format: "zugferd-2.5-en16931" }),
      ];
      console.log(results.map(r => !r.ok && r.error.code + ":" + r.error.issues[0].code + ":" + /requires/.test(r.error.issues[0].message)).join(","));
    `),
    ).toBe("INTERNAL:validator_unavailable:true,INTERNAL:validator_unavailable:true");
  });
});

describe("property: random valid packages", () => {
  // Seeded generator; the test never depends on the clock or Math.random.
  function random(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const alphabet = [
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ÄÖÜäöüß§@€#|`´'^°%&\"*~:;.-/+=_?$!{}[](),<>\\éàçñ漢字한국 ",
  ];

  test("serialize, pass the XSD, and round-trip amounts, texts and files", async () => {
    const next = random(20261018);
    const int = (max: number) => Math.floor(next() * max);
    const pick = <T>(values: readonly T[]) => values[int(values.length)]!;
    const word = (max: number) => {
      const length = 1 + int(max);
      let value = "";
      for (let i = 0; i < length; i++) value += pick(alphabet);
      value = value.trim();
      return value.length ? value : "x";
    };
    const cents = (signed: boolean) => {
      const value = BigInt(1 + int(10 ** (1 + int(9))));
      const negative = signed && next() < 0.5;
      const text = `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
      return negative ? `-${text}` : text;
    };
    for (let round = 0; round < 60; round++) {
      let fileIndex = 0;
      const documents: DatevXmlDocument[] = Array.from({ length: 1 + int(5) }, () => {
        const day = String(1 + int(28)).padStart(2, "0");
        const files = Array.from({ length: int(3) }, () => ({ name: `f${fileIndex++}.pdf`, bytes: samplePdf(String(int(1e6))) }));
        const line = () => ({
          ...(next() < 0.5 ? { taxRate: pick(["19.00", "7.00", "0.00"]) } : {}),
          ...(next() < 0.3 ? { costCenter1: word(36) } : {}),
          ...(next() < 0.3 ? { information: word(120) } : {}),
          ...(next() < 0.2 ? { account: String(1000 + int(9000)) } : {}),
        });
        if (next() < 0.4) {
          return cash({
            documentDate: `2026-10-${day}`,
            files,
            lines: Array.from({ length: 1 + int(6) }, () => ({ amount: cents(true), text: word(30), ...line() })),
          });
        }
        const negative = next() < 0.3;
        const make = next() < 0.5 ? payable : receivable;
        return make({
          documentDate: `2026-10-${day}`,
          documentNumber: `R-${int(1e6)}`,
          partyName: word(50),
          files,
          lines: Array.from({ length: 1 + int(6) }, () => ({
            amount: (negative ? "-" : "") + cents(false),
            ...(next() < 0.5 ? { text: word(30) } : {}),
            ...line(),
          })),
        });
      });
      const input = pack(documents, { description: word(255) });
      const file = await expectSchemaValid(input);
      const entries = readZip(file.bytes);
      const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]));
      input.documents.forEach((document, index) => {
        if (document.kind === "documentImage") throw new Error("Expected a ledger document.");
        const written = file.documents[index]!;
        if (written.dataFile === undefined) throw new Error("Expected a ledger data file.");
        const sum = document.lines.reduce((total, line) => total + BigInt(line.amount.replace(".", "")), 0n);
        expect(BigInt(written.amount.replace(".", ""))).toBe(sum);
        expect(new TextDecoder().decode(byName.get(written.dataFile))).toBe(written.xml);
        expect(texts(written.xml, "amount")).toEqual(document.lines.map((line) => line.amount));
        expect(texts(written.xml, "bookingText")).toEqual(document.lines.flatMap((line) => (line.text === undefined ? [] : [line.text])));
        for (const attachment of document.files) expect(byName.get(attachment.name)).toEqual(attachment.bytes);
      });
      expect(entries).toHaveLength(1 + input.documents.length + fileIndex);
    }
  }, 60_000);

  test("random BMP text is accepted exactly when it is inside the DATEV repertoire", () => {
    const next = random(7);
    const allowed = /^[A-Za-z0-9§@€#|`´'^°%&"*~:;.\-/+=_ ?$!{}[\],()<>\\ -ÿ一-鿿가-힯]+$/;
    for (let i = 0; i < 2000; i++) {
      const code = Math.floor(next() * 0xd7ff) + 1;
      const value = `A${String.fromCharCode(code)}B`;
      const ok = datevXml.validate(pack([payable({ partyName: value })])).ok;
      expect(ok).toBe(allowed.test(value) && value === value.normalize("NFC"));
    }
  });
});

describe("property: malformed input never throws", () => {
  test("random structural damage returns a BAD_INPUT result", () => {
    let seed = 99;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    const junk = [
      null,
      undefined,
      0,
      -1,
      1.5,
      "",
      "x",
      "-",
      [],
      {},
      [null],
      [{}],
      true,
      new Uint8Array(),
      "9999999999999.99",
      "2026-13-45",
    ];
    const base = pack([
      payable({ guid: "0f8fad5b-d9cb-469f-a165-70867728950e", files: [{ name: "a.pdf", bytes: pdf }] }),
      receivable({ lines: [{ amount: "-1.00" }, { amount: "-2.00" }] }),
      cash({ files: [{ name: "b.pdf", bytes: pdf }] }),
    ]);
    const paths: (string | number)[][] = [];
    const walk = (value: unknown, path: (string | number)[]) => {
      if (value instanceof Uint8Array) {
        paths.push(path);
        return;
      }
      if (value && typeof value === "object") {
        paths.push(path);
        for (const [key, child] of Object.entries(value)) walk(child, [...path, Array.isArray(value) ? Number(key) : key]);
      } else paths.push(path);
    };
    walk(base, []);
    for (let i = 0; i < 3000; i++) {
      const input = structuredClone(base) as unknown as Record<string | number, unknown>;
      for (let damage = 0; damage < 1 + Math.floor(next() * 3); damage++) {
        const path = paths[Math.floor(next() * paths.length)]!;
        if (path.length === 0) continue;
        let parent = input;
        for (const key of path.slice(0, -1)) {
          const child = parent?.[key];
          if (!child || typeof child !== "object") {
            parent = undefined as never;
            break;
          }
          parent = child as Record<string | number, unknown>;
        }
        if (parent) parent[path.at(-1)!] = junk[Math.floor(next() * junk.length)];
      }
      const result = datevXml.serialize(input as never);
      if (!result.ok) {
        expect(result.error.code).toBe("BAD_INPUT");
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    }
    for (const value of [null, undefined, 1, "x", [], {}, { documents: null }, { ...base, documents: [null] }])
      expect(datevXml.validate(value).ok).toBe(false);
  });
});
