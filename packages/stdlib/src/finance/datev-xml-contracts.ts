import Big from "big.js";
import { isValidBIC, isValidIBAN } from "ibantools";
import { z } from "zod";
import { datevGuid } from "./datev-guid";

// DATEV XML-Schnittstelle online 6.0 (Belegtransfer), retrieved 2026-10-18:
// https://developer.datev.de/de/file-format/details/datev-xml-interface-online/getting-started
// The pinned XSDs decide types and order; the portal adds charset, file and size rules.

/** Hard limits from the DATEV portal and the pinned XSDs. */
export const datevXmlLimits = {
  /** `archive/content/document` maxOccurs in Document_v060.xsd (the portal text says 5000). */
  documents: 4999,
  /** Ledger rows per data file (`consolidate` choice maxOccurs). */
  lines: 5000,
  /** `document/extension` maxOccurs is 50, one of which is the ledger data file. */
  filesPerDocument: 49,
  /** "Individual files ... must not exceed 20MB"; read as decimal megabytes. */
  fileBytes: 20_000_000,
  /** "Technical size limit of 465MB" per package; DATEV recommends about 100 MB. */
  packageBytes: 465_000_000,
  /** Classic ZIP without ZIP64. */
  zipEntries: 0xffff,
} as const;

// Portal, section "Charset": UTF-8 restricted to this repertoire, precomposed (NFC).
// Tab, CR and LF are allowed there but rejected here because every supported field is single-line.
// Latin-1 control characters U+0080..U+009F are excluded conservatively.
const datevCharacters = /^[A-Za-z0-9§@€#|`´'^°%&"*~:;.\-/+=_ ?$!{}[\],()<>\\ -ÿ一-鿿가-힯]*$/;

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => value === value.normalize("NFC") || !datevCharacters.test(value.normalize("NFC")),
      'Use Unicode NFC (precomposed characters); call value.normalize("NFC") before serializing.',
    )
    .refine(
      (value) => datevCharacters.test(value) || (value !== value.normalize("NFC") && datevCharacters.test(value.normalize("NFC"))),
      "Contains a character outside the DATEV XML character set (for example a typographic quote, dash, emoji or control character).",
    )
    .refine((value) => value.trim() === value && value.trim().length > 0, "Leading, trailing or blank-only whitespace is not allowed.");

const year = (value: string) => value >= "2000" && value < "2100";
const date = z.iso.date().refine(year, "DATEV dates must be in 2000–2099.");
const period = z
  .string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "Expected a period YYYY-MM.")
  .refine(year, "DATEV periods must be in 2000–2099.");
const amount = z
  .string()
  .regex(/^-?(?:0|[1-9]\d{0,9})\.\d{2}$/, 'Expected a decimal string with exactly two fraction digits, for example "-12.30".')
  .refine((value) => /[1-9]/.test(value), "DATEV does not accept an amount of 0.00.");
const accountNumber = z.string().regex(/^[1-9]\d{0,8}$/, "Expected 1–9 digits without a leading zero.");
const documentNumber = z
  .string()
  .regex(/^[A-Za-z0-9$%&*+\-/]{1,36}$/, "Expected 1–36 ASCII letters, digits or $%&*+-/ (no underscore, dot or space).");

const extensions = [
  "pdf",
  "xml",
  "tif",
  "tiff",
  "bmp",
  "csv",
  "doc",
  "docx",
  "gif",
  "jpeg",
  "jpg",
  "ods",
  "odt",
  "png",
  "rtf",
  "txt",
  "xls",
  "xlsx",
] as const;
const fileName = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,94}\\.(?:${extensions.join("|")})$`, "i"),
    `Expected an ASCII file name (letters, digits, ".", "_", "-"; at most 100 characters) with one of the DATEV file types: ${extensions.join(", ")}.`,
  )
  .refine((value) => !/^(?:con|prn|aux|nul|com\d|lpt\d)\./i.test(value), "Windows reserves this file name.")
  .refine((value) => value.toLowerCase() !== "document.xml", "document.xml is reserved for the administrative file.")
  .refine(
    (value) => !/^datev-ledger-\d+\.xml$/i.test(value),
    "Names like datev-ledger-0001.xml are reserved for the generated ledger files.",
  );

const signatures: Record<string, (bytes: Uint8Array) => boolean> = {
  // PDF allows up to 1024 bytes before the header.
  pdf: (bytes) => new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-"),
  png: (bytes) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte),
  jpg: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  jpeg: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  gif: (bytes) => new TextDecoder("latin1").decode(bytes.subarray(0, 6)).startsWith("GIF8"),
  bmp: (bytes) => bytes[0] === 0x42 && bytes[1] === 0x4d,
  tif: (bytes) =>
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a),
};
signatures.tiff = signatures.tif!;

export const DatevXmlAttachmentSchema = z
  .object({
    name: fileName,
    bytes: z
      .custom<Uint8Array>((value) => value instanceof Uint8Array, { message: "Expected file bytes as Uint8Array." })
      .refine((bytes) => bytes.byteLength > 0, "Empty files are not allowed.")
      .refine((bytes) => bytes.byteLength <= datevXmlLimits.fileBytes, "DATEV accepts files up to 20 MB."),
  })
  .strict();

const ledgerLine = {
  amount,
  /** Gegenkonto (`accountNo`): general-ledger or person account. */
  account: accountNumber.optional(),
  buCode: z
    .string()
    .regex(/^(?:0|[1-9]\d{0,3})$/, "Expected a BU key of 1–4 digits without a leading zero.")
    .optional(),
  costCenter1: text(36).optional(),
  costCenter2: text(36).optional(),
  taxRate: z
    .string()
    .regex(/^(?:0|[1-9]\d?)\.\d{2}$/, "Expected a rate from 0.00 to 99.99 with two fraction digits.")
    .optional(),
  information: text(120).optional(),
};

export const DatevXmlInvoiceLineSchema = z
  .object({
    ...ledgerLine,
    /** Belegtext; DATEV documents 30 characters for the booking text. */
    text: text(30).optional(),
  })
  .strict();

export const DatevXmlCashLineSchema = z
  .object({
    ...ledgerLine,
    /** Required for cash; Kassenbuch online uses only the first 30 characters, so longer text fails. */
    text: text(30),
    documentNumber: documentNumber.optional(),
  })
  .strict();

const files = z.array(DatevXmlAttachmentSchema).max(datevXmlLimits.filesPerDocument);
const common = {
  guid: datevGuid.optional(),
  period,
  documentDate: date,
  files,
};

const invoiceDocument = {
  ...common,
  /** Key 3: name of the invoice folder in Belege online, for example "Eingangsrechnungen". */
  folder: text(40),
  documentNumber,
  deliveryDate: date.optional(),
  dueDate: date.optional(),
  paidAt: date.optional(),
  partyId: text(15).optional(),
  partyAccount: z
    .string()
    .regex(/^[1-9]\d{4,8}$/, "Expected a person account of 5–9 digits (10000–999999999).")
    .optional(),
  partyName: text(50).optional(),
  partyCity: text(30).optional(),
  vatId: z
    .string()
    .regex(/^[A-Z]{2}[0-9A-Z]{2,13}$/, "Expected a VAT ID like DE123456789 without spaces.")
    .optional(),
  iban: z
    .string()
    .regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/, "Expected an uppercase IBAN without spaces.")
    .refine((value) => isValidIBAN(value), "Invalid IBAN checksum or structure.")
    .optional(),
  bic: z
    .string()
    .regex(/^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/, "Expected an uppercase BIC.")
    .refine(isValidBIC, "Invalid BIC.")
    .optional(),
  lines: z.array(DatevXmlInvoiceLineSchema).min(1).max(datevXmlLimits.lines),
};

export const DatevXmlAccountsPayableSchema = z.object({ kind: z.literal("accountsPayableLedger"), ...invoiceDocument }).strict();
export const DatevXmlAccountsReceivableSchema = z.object({ kind: z.literal("accountsReceivableLedger"), ...invoiceDocument }).strict();
export const DatevXmlCashSchema = z
  .object({
    kind: z.literal("cashLedger"),
    ...common,
    /** Key 2 or key 3: Kassenbuch online needs exactly one of them. */
    cashRegister: z.union([z.object({ accountNumber: accountNumber }).strict(), z.object({ name: text(40) }).strict()], {
      message: "Expected exactly one of { accountNumber } or { name }.",
    }),
    lines: z.array(DatevXmlCashLineSchema).min(1).max(datevXmlLimits.lines),
  })
  .strict();

// Document_v060.xsd permits File-only extensions (1..50), with optional guid.
// This application contract requires guid so an EXTF Beleglink can refer to the image.
// https://developer.datev.de/de/file-formats/details/datev-xml-interface-online/format-specification/administrative-data-file
export const DatevXmlDocumentImageSchema = z
  .object({
    kind: z.literal("documentImage"),
    guid: datevGuid,
    files: files.min(1),
  })
  .strict();

export const DatevXmlDocumentSchema = z.discriminatedUnion("kind", [
  DatevXmlAccountsPayableSchema,
  DatevXmlAccountsReceivableSchema,
  DatevXmlCashSchema,
  DatevXmlDocumentImageSchema,
]);

export const DatevXmlPackageSchema = z
  .object({
    format: z.literal("datev-xml-online-6.0"),
    currency: z.literal("EUR"),
    /** Local wall-clock creation time without offset, as the XSD forbids a zone. */
    createdAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "Expected local time YYYY-MM-DDTHH:mm:ss without offset.")
      .refine(
        (value) => z.iso.datetime({ local: true }).safeParse(value).success && year(value),
        "Expected a real local time in 2000–2099.",
      ),
    /** `generator_info`: company that created the data; DATEV shows it as sender in the invoice lists. */
    generatorInfo: text(40),
    /** `generatingSystem` / `generating_system`: name of the software. */
    generatingSystem: text(40).optional(),
    description: text(255).optional(),
    documents: z.array(DatevXmlDocumentSchema).min(1).max(datevXmlLimits.documents),
  })
  .strict();

type Issue = { code: "invalid_input" | "input_limit"; path: (string | number)[]; message: string };

const Decimal = Big();
/** consolidatedAmount (de:p10002) allows at most ten integer digits by pattern. */
const maxConsolidated = new Decimal("9999999999.99");
/** Exact signed sum of a document's lines. */
export const consolidatedAmount = (document: Exclude<DatevXmlDocument, DatevXmlDocumentImage>) =>
  document.lines.reduce((sum, line) => sum.plus(line.amount), new Decimal(0));

/**
 * Rules across fields, documents and files. Runs only on input that already matches
 * DatevXmlPackageSchema, so every value has its declared type and length.
 */
export function checkDatevXmlPackage(input: DatevXmlPackage): Issue[] {
  const issues: Issue[] = [];
  const issue = (path: (string | number)[], message: string, code: Issue["code"] = "invalid_input") => issues.push({ code, path, message });
  const guids = new Map<string, number>();
  const names = new Map<string, string>();
  let bytes = 0;
  let entries = 1;
  input.documents.forEach((document, index) => {
    const at = (...path: (string | number)[]) => ["documents", index, ...path];
    if (document.kind !== "documentImage" && !document.documentDate.startsWith(`${document.period}-`))
      issue(at("documentDate"), "The document date must lie within the period.");
    if (document.guid !== undefined) {
      if (document.files.length === 0) issue(at("guid"), "A GUID needs at least one file; DATEV attaches it to the (first) file.");
      const key = document.guid.toLowerCase();
      const first = guids.get(key);
      if (first !== undefined) issue(at("guid"), `Duplicate GUID; DATEV would skip this document (first used by document ${first}).`);
      else guids.set(key, index);
    }
    if (document.kind === "accountsPayableLedger" || document.kind === "accountsReceivableLedger") {
      const negative = document.lines[0]!.amount.startsWith("-");
      document.lines.forEach((line, lineIndex) => {
        if (line.amount.startsWith("-") !== negative)
          issue(
            at("lines", lineIndex, "amount"),
            "All lines of an invoice must have the same sign; negative amounts mark a correction (Rechnungskorrektur).",
          );
      });
      if (document.deliveryDate !== undefined && document.deliveryDate > document.documentDate)
        issue(at("deliveryDate"), "DATEV ignores a delivery date after the document date; omit it instead.");
      if (document.dueDate !== undefined && document.dueDate < document.documentDate)
        issue(at("dueDate"), "The due date must not lie before the document date.");
      // bpAccountNo: DATEV person accounts have one digit more than the client's account length;
      // creditors start with 7–9, debtors with 1–6 (for example 70000 and 10000 at length 4).
      // Unternehmen online does not check this, so a wrong direction would pass unnoticed.
      if (document.partyAccount !== undefined && (document.kind === "accountsPayableLedger") !== /^[7-9]/.test(document.partyAccount))
        issue(
          at("partyAccount"),
          document.kind === "accountsPayableLedger"
            ? "An incoming invoice needs a creditor account (first digit 7–9, for example 70000)."
            : "An outgoing invoice needs a debtor account (first digit 1–6, for example 10000).",
        );
    }
    if (document.kind !== "documentImage" && consolidatedAmount(document).abs().gt(maxConsolidated))
      issue(at("lines"), "The sum of the lines exceeds DATEV's consolidated amount range of ±9999999999.99.", "input_limit");
    entries += (document.kind === "documentImage" ? 0 : 1) + document.files.length;
    document.files.forEach((file, fileIndex) => {
      bytes += file.bytes.byteLength;
      const extension = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
      if (signatures[extension] && !signatures[extension](file.bytes))
        issue(at("files", fileIndex, "bytes"), `The bytes are not a ${extension.toUpperCase()} file.`);
      const key = file.name.toLowerCase();
      const first = names.get(key);
      // Belegtransfer runs on Windows, so names must also differ in more than letter case.
      if (first !== undefined)
        issue(at("files", fileIndex, "name"), `Duplicate file name in the package (case-insensitive); already used by ${first}.`);
      else names.set(key, `document ${index}, file ${fileIndex}`);
    });
  });
  if (entries > datevXmlLimits.zipEntries)
    issue(
      ["documents"],
      `The package would contain ${entries} ZIP entries; split it (at most ${datevXmlLimits.zipEntries}).`,
      "input_limit",
    );
  if (bytes > datevXmlLimits.packageBytes)
    issue(
      ["documents"],
      "The files exceed DATEV's 465 MB package limit; split the package (DATEV recommends about 100 MB).",
      "input_limit",
    );
  return issues;
}

/** Deterministic name of the ledger data file for a zero-based document index. */
export const ledgerFileName = (index: number) => `datev-ledger-${String(index + 1).padStart(4, "0")}.xml`;

export type DatevXmlAttachment = z.infer<typeof DatevXmlAttachmentSchema>;
export type DatevXmlInvoiceLine = z.infer<typeof DatevXmlInvoiceLineSchema>;
export type DatevXmlCashLine = z.infer<typeof DatevXmlCashLineSchema>;
export type DatevXmlAccountsPayable = z.infer<typeof DatevXmlAccountsPayableSchema>;
export type DatevXmlAccountsReceivable = z.infer<typeof DatevXmlAccountsReceivableSchema>;
export type DatevXmlCash = z.infer<typeof DatevXmlCashSchema>;
export type DatevXmlDocumentImage = z.infer<typeof DatevXmlDocumentImageSchema>;
export type DatevXmlDocument = z.infer<typeof DatevXmlDocumentSchema>;
export type DatevXmlPackage = z.infer<typeof DatevXmlPackageSchema>;
