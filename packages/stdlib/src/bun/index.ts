// Bun server utilities.
import { join } from "node:path";
import { datevXmlSchemaSha256, type DatevXmlSchemas } from "../finance/datev-xml-schema-files";

/**
 * Read DATEV's XML-Schnittstelle online 6.0 schema files from a directory, for
 * `createDatevXmlPackage` and `validateDatevXml` in `@k2b/stdlib/finance/validate`.
 * Only the four required file names are read; a missing file is left out, so the
 * validation reports it (`validator_unavailable`) together with the source URL.
 * Contents are not checked here; every validation verifies the pinned SHA-256.
 */
export async function loadDatevXmlSchemas(directory: string): Promise<DatevXmlSchemas> {
  const schemas: Record<string, string> = {};
  for (const name of Object.keys(datevXmlSchemaSha256)) {
    const file = Bun.file(join(directory, name));
    if (await file.exists()) schemas[name] = await file.text();
  }
  return schemas;
}
