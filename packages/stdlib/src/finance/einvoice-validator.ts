import { ParseOption, XmlBufferInputProvider, XmlDocument, XmlLibError, XmlParseError, XsdValidator, xmlRegisterInputProvider } from "libxml2-wasm";
import { ok } from "../result";
import { invalid, type FinanceResult } from "./common";
import { invoiceSchemas, invoiceSchemaSha256 } from "./einvoice-schema";

const prefix = "stdlib-einvoice-2.5:/";
let registered = false;
// One compiled schema lives with this module. It owns its resolved imports and
// remains usable if another libxml2 consumer clears the global input providers.
let compiled: XsdValidator | undefined;
/** Synchronous schema work after integrity verification; no await while using WASM documents. */
export async function validateInvoiceSchema(xml: string): Promise<FinanceResult<void>> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(invoiceSchemas)));
  if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") !== invoiceSchemaSha256) return invalid([{ code: "schema_integrity", path: [], message: "Pinned invoice schemas have changed." }], true);
  if (!registered) {
    const buffers = Object.fromEntries(Object.entries(invoiceSchemas).map(([name, schema]) => [prefix + name, new TextEncoder().encode(schema)]));
    // This provider only serves this package's fixed schema URLs. Never clear another caller's providers.
    if (!xmlRegisterInputProvider(new XmlBufferInputProvider(buffers))) throw new Error("Cannot register invoice schema provider.");
    registered = true;
  }
  const options = { option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NO_SYS_CATALOG };
  let document: XmlDocument | undefined;
  try {
    if (!compiled) {
      const main = "FACTUR-X_EN16931.xsd";
      const schema = XmlDocument.fromString(invoiceSchemas[main]!, { ...options, url: prefix + main });
      try { compiled = XsdValidator.fromDoc(schema); }
      finally { schema.dispose(); }
    }
    document = XmlDocument.fromString(xml, options);
    compiled.validate(document);
    return ok();
  } catch (error) {
    if (!(error instanceof XmlLibError)) throw error;
    return invalid(error.details.map(detail => ({ code: error instanceof XmlParseError ? "invalid_xml" : "schema_mismatch", path: ["xml"], message: detail.message, ...(detail.line > 0 ? { line: detail.line } : {}) })));
  } finally {
    document?.dispose();
  }
}
