import { ParseOption, XmlBufferInputProvider, XmlDocument, XmlLibError, XmlParseError, XsdValidator, xmlRegisterInputProvider } from "libxml2-wasm";
import { ok } from "../result";
import { invalid, type FinanceIssue, type FinanceResult } from "./common";
import { datevXmlSchemaSha256, datevXmlSchemaSource, type DatevXmlSchemaFile } from "./datev-xml-schema-files";

export type DatevXmlSchemaKind = "document" | "ledger";

const prefix = "stdlib-datev-xml-6.0:/";
const entry: Record<DatevXmlSchemaKind, DatevXmlSchemaFile> = {
  document: "Document_v060.xsd",
  ledger: "Belegverwaltung_online_ledger_import_v060.xsd",
};
const files = Object.keys(datevXmlSchemaSha256) as DatevXmlSchemaFile[];
const source = `DATEV XML-Schnittstelle online ${datevXmlSchemaSource.version} (${datevXmlSchemaSource.url})`;
const options = { option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NO_SYS_CATALOG };
// Supplied schemas must match the pinned hashes, so every accepted set has identical content.
// Both schemas are compiled once, right after registering the provider and without an await in
// between. Compiled schemas own their resolved imports and stay usable if another libxml2
// consumer later clears the global input providers.
let compiled: Record<DatevXmlSchemaKind, XsdValidator> | undefined;

const hex = (digest: ArrayBuffer) => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");

/** Check presence and pinned SHA-256 of every required schema file. */
export async function verifyDatevSchemas(schemas: unknown): Promise<FinanceResult<Record<DatevXmlSchemaFile, string>>> {
  const map = schemas !== null && typeof schemas === "object" ? schemas as Record<string, unknown> : {};
  const missing = files.filter(name => typeof map[name] !== "string");
  if (missing.length) return invalid(missing.map(name => ({ code: "validator_unavailable" as const, path: ["schemas", name],
    message: `Missing DATEV schema file ${name}; supply it from ${source}.` })), true);
  const issues: FinanceIssue[] = [];
  for (const name of files) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(map[name] as string));
    if (hex(digest) !== datevXmlSchemaSha256[name])
      issues.push({ code: "schema_integrity", path: ["schemas", name], message: `${name} does not match the pinned SHA-256 of ${source}.` });
  }
  return issues.length ? invalid(issues, true) : ok(map as Record<DatevXmlSchemaFile, string>);
}

function compileSchemas(schemas: Record<DatevXmlSchemaFile, string>): Record<DatevXmlSchemaKind, XsdValidator> {
  const buffers = Object.fromEntries(files.map(name => [prefix + name, new TextEncoder().encode(schemas[name])]));
  // This provider only serves this package's fixed schema URLs. Never clear another caller's
  // providers. Registering again after a failed compilation is harmless.
  if (!xmlRegisterInputProvider(new XmlBufferInputProvider(buffers))) throw new Error("Cannot register DATEV schema provider.");
  const result: Partial<Record<DatevXmlSchemaKind, XsdValidator>> = {};
  try {
    for (const kind of ["document", "ledger"] as const) {
      const schema = XmlDocument.fromString(schemas[entry[kind]], { ...options, url: prefix + entry[kind] });
      try { result[kind] = XsdValidator.fromDoc(schema); }
      finally { schema.dispose(); }
    }
  } catch (error) {
    result.document?.dispose();
    result.ledger?.dispose();
    throw error;
  }
  return result as Record<DatevXmlSchemaKind, XsdValidator>;
}

/** Synchronous schema work after verification; no await while WASM documents are open. */
export function validateDatevSchema(xml: string, kind: DatevXmlSchemaKind, schemas: Record<DatevXmlSchemaFile, string>, path: (string | number)[] = ["xml"]): FinanceResult<void> {
  if (!compiled) {
    // Verified schemas always compile; a failure here is an engine problem, never the caller's XML.
    try { compiled = compileSchemas(schemas); }
    catch { return invalid([{ code: "validator_unavailable", path: [], message: "The DATEV schemas could not be compiled." }], true); }
  }
  let document: XmlDocument | undefined;
  try {
    document = XmlDocument.fromString(xml, options);
    compiled[kind].validate(document);
    return ok();
  } catch (error) {
    if (!(error instanceof XmlLibError)) throw error;
    return invalid(error.details.map((detail): FinanceIssue => ({
      code: error instanceof XmlParseError ? "invalid_xml" : "schema_mismatch",
      path, message: detail.message,
      ...(detail.line > 0 ? { line: detail.line } : {}),
      ...(detail.col > 0 ? { column: detail.col } : {}),
    })));
  } finally {
    document?.dispose();
  }
}
