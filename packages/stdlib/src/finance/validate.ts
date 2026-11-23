import { invalid, type FinanceResult } from "./common";

export const sepaSchemaSha256 = "35cfe972a636392704fd930c3e0496fc05b95ff891deb635b168dcdabf3c08a3";

/** Check XML against the pinned DK XSD; does not check business rules or totals. */
export async function validateSepaXml(xml: string): Promise<FinanceResult<void>> {
  if (typeof xml !== "string" || xml.includes("<!")) {
    return invalid([{ code: "invalid_xml", path: ["xml"], message: "Expected XML without DTD, comments or CDATA." }]);
  }
  // XSD and WASM are not loaded by DATEV, input validation or normal stdlib imports.
  try {
    const { validatePinnedXml } = await import("./sepa-validator");
    return await validatePinnedXml(xml, sepaSchemaSha256);
  } catch {
    return invalid([{ code: "validator_unavailable", path: [], message: "SEPA validation requires libxml2-wasm@0.6.0 and Web Crypto." }], true);
  }
}

export const camtSchemaSha256 = "589b55980dd6e553de78ba036eb733308da201bda4c3158e10b22cb003911e8f";

/** Validate ISO camt.052.001.08, not a bank-specific usage profile or accounting semantics. */
export async function validateCamtXml(xml: string, options?: import("./camt-types").CamtParseOptions): Promise<FinanceResult<void>> {
  // The JS reader enforces namespace, DTD and resource boundaries before invoking WASM.
  try {
    const { readCamtXml, CamtReadError } = await import("./camt-xml");
    try { readCamtXml(xml, options); }
    catch (error) {
      if (error instanceof CamtReadError) return invalid([error.issue]);
      throw error;
    }
    const [{ validateSchemaXml }, { camtSchema }] = await Promise.all([
      import("./xml-schema-validator"), import("./camt-schema"),
    ]);
    return await validateSchemaXml(xml, camtSchema, camtSchemaSha256);
  } catch {
    return invalid([{ code: "validator_unavailable", path: [], message: "CAMT validation requires saxes@6, libxml2-wasm@0.6.0 and Web Crypto." }], true);
  }
}

/** Check the pinned CII EN16931 profile XSD only. Does not execute Schematron or recalculate amounts. */
export async function validateInvoiceXml(xml: string, options: { format: import("./einvoice-contracts").InvoiceFormat; mode?: "incoming" } & import("./einvoice-contracts").InvoiceParseOptions): Promise<FinanceResult<void>> {
  if (options?.format !== "zugferd-2.5-en16931") return invalid([{ code: "unsupported_format", path: ["format"], message: "Expected zugferd-2.5-en16931." }]);
  const { format: _, mode, ...limits } = options;
  if (mode !== undefined && mode !== "incoming") return invalid([{ code: "invalid_input", path: ["options", "mode"], message: "Unknown invoice validation mode." }]);
  let reader: typeof import("./einvoice-read");
  try { reader = await import("./einvoice-read"); }
  catch { return invalid([{ code: "validator_unavailable", path: [], message: "Invoice validation requires saxes@6, libxml2-wasm@0.6.0 and Web Crypto." }], true); }
  const { readInvoiceTree, InvoiceReadError } = reader;
  try { readInvoiceTree(xml, limits, mode === "incoming"); }
  catch (error) { if (error instanceof InvoiceReadError) return invalid([error.issue]); throw error; }
  try {
    const { validateInvoiceSchema } = await import("./einvoice-validator");
    return await validateInvoiceSchema(xml);
  } catch {
    return invalid([{ code: "validator_unavailable", path: [], message: "Invoice XSD validation requires libxml2-wasm@0.6.0 and Web Crypto." }], true);
  }
}

export { datevXmlSchemaSha256, datevXmlSchemaSource, type DatevXmlSchemas, type DatevXmlSchemaFile } from "./datev-xml-schema-files";

const datevUnavailable = () => invalid([{ code: "validator_unavailable", path: [],
  message: "DATEV XML validation requires zod, ibantools, libxml2-wasm@0.6.0 and Web Crypto." }], true);

/**
 * Check one DATEV XML-Schnittstelle online 6.0 file against DATEV's XSD:
 * `schema: "document"` for document.xml, `"ledger"` for a ledger data file.
 * `schemas` maps the XSD file names to their text; missing files or a hash mismatch
 * return INTERNAL (`validator_unavailable` / `schema_integrity`). Checks the schema only.
 */
export async function validateDatevXml(xml: string, options: { schema: "document" | "ledger"; schemas: import("./datev-xml-schema-files").DatevXmlSchemas }): Promise<FinanceResult<void>> {
  if (options?.schema !== "document" && options?.schema !== "ledger")
    return invalid([{ code: "invalid_input", path: ["options", "schema"], message: "Expected schema \"document\" or \"ledger\"." }]);
  try {
    const { verifyDatevSchemas, validateDatevSchema } = await import("./datev-xml-validator");
    const schemas = await verifyDatevSchemas(options.schemas);
    if (!schemas.ok) return schemas;
    // Comments are harmless (DATEV's own samples contain them); DTDs and CDATA are rejected before parsing.
    if (typeof xml !== "string" || /<!(?!--)/.test(xml)) return invalid([{ code: "invalid_xml", path: ["xml"], message: "Expected XML without DTD or CDATA." }]);
    return validateDatevSchema(xml, options.schema, schemas.data);
  } catch {
    return datevUnavailable();
  }
}

/**
 * Build the Belegtransfer ZIP and check document.xml and every ledger data file against
 * DATEV's XSD. Returns no bytes unless the schemas verify and every XML file is valid.
 * Schema issues use the path ["xml", <file name inside the ZIP>].
 */
export async function createDatevXmlPackage(input: import("./datev-xml-contracts").DatevXmlPackage, options: { schemas: import("./datev-xml-schema-files").DatevXmlSchemas }): Promise<FinanceResult<import("./datev-xml").DatevXmlFile>> {
  try {
    const [{ datevXml }, { verifyDatevSchemas, validateDatevSchema }] = await Promise.all([import("./datev-xml"), import("./datev-xml-validator")]);
    // The schemas are checked first: without them no package is built at all.
    const schemas = await verifyDatevSchemas(options?.schemas);
    if (!schemas.ok) return schemas;
    const file = datevXml.serialize(input);
    if (!file.ok) return file;
    const parts = [
      { name: "document.xml", xml: file.data.documentXml, schema: "document" as const },
      ...file.data.documents.flatMap(document => document.dataFile === undefined ? [] : [{ name: document.dataFile, xml: document.xml, schema: "ledger" as const }]),
    ];
    const issues: import("./common").FinanceIssue[] = [];
    for (const part of parts) {
      const checked = validateDatevSchema(part.xml, part.schema, schemas.data, ["xml", part.name]);
      if (!checked.ok) {
        if (checked.error.code === "INTERNAL") return checked;
        issues.push(...checked.error.issues);
      }
    }
    return issues.length ? invalid(issues) : file;
  } catch {
    return datevUnavailable();
  }
}
