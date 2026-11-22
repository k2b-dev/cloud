import { sepaSchema } from "./sepa-schema";
import { validateSchemaXml } from "./xml-schema-validator";

export const validatePinnedXml = (xml: string, expectedHash: string) => validateSchemaXml(xml, sepaSchema, expectedHash);
