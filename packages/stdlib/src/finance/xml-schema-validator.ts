import { ParseOption, XmlDocument, XmlLibError, XmlParseError, XsdValidator } from "libxml2-wasm";
import { ok } from "../result";
import { invalid, type FinanceResult } from "./common";

export async function validateSchemaXml(xml: string, schema: string, expectedHash: string): Promise<FinanceResult<void>> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(schema));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== expectedHash) return invalid([{ code: "schema_integrity", path: [], message: "The pinned XML schema has changed." }], true);
  const options = { option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NO_SYS_CATALOG };
  const schemaDocument = XmlDocument.fromString(schema, options);
  let validator: XsdValidator | undefined;
  let document: XmlDocument | undefined;
  try {
    validator = XsdValidator.fromDoc(schemaDocument);
    document = XmlDocument.fromString(xml, options);
    validator.validate(document);
    return ok();
  } catch (error) {
    if (!(error instanceof XmlLibError)) throw error;
    return invalid(error.details.map(detail => ({
      code: error instanceof XmlParseError ? "invalid_xml" : "schema_mismatch",
      path: ["xml"], message: detail.message,
      ...(detail.line > 0 ? { line: detail.line } : {}),
      ...(detail.col > 0 ? { column: detail.col } : {}),
    })));
  } finally {
    document?.dispose();
    validator?.dispose();
    schemaDocument.dispose();
  }
}
