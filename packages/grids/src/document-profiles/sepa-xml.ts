import { unwrap } from "@k2b/stdlib";
import { sepa } from "@k2b/stdlib/finance";
import { sepaSchemaSha256, validateSepaXml } from "@k2b/stdlib/finance/validate";
import type { z } from "zod";
import { SepaBatchSchema, sepaFormatInput } from "./sepa-xml-contracts";

/** The persisted issuance context owns IDs/time; stdlib owns bytes and XSD. */
export const renderSepaBatch = async (input: z.input<typeof SepaBatchSchema>, issuedAt: Date) => {
  const batch = SepaBatchSchema.parse(input);
  const rendered = unwrap(sepa.serialize(sepaFormatInput(batch, issuedAt.toISOString())));
  unwrap(await validateSepaXml(new TextDecoder().decode(rendered.bytes)));
  return { ...rendered, schemaSha256: sepaSchemaSha256 };
};
