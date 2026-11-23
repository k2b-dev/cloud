import { validateSchemaXml } from "./xml-schema-validator";
import { sepaSchema } from "./sepa-schema";

export const validatePinnedXml = (xml: string, expectedHash: string) => validateSchemaXml(xml, sepaSchema, expectedHash);
