import { unwrap } from "@k2b/stdlib";
import { datev } from "@k2b/stdlib/finance";
import type { z } from "zod";
import { DatevBatchSchema, datevFormatInput } from "./datev-csv-contracts";

/** Map Grids identities out of the file, never out of the captured input. */
export const renderDatevBatch = (input: z.input<typeof DatevBatchSchema>, issuedAt: Date) => {
  const batch = DatevBatchSchema.parse(input);
  const rendered = unwrap(datev.serialize(datevFormatInput(batch, issuedAt.toISOString())));
  return { ...rendered, businessCount: new Set(batch.rows.map((row) => row.businessId)).size };
};
