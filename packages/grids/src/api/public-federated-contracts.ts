import { z } from "zod";
import { ShortIdSchema } from "../contracts";

export const PublicFederatedMappingSchema = z
  .object({
    targetFieldId: ShortIdSchema,
    sourceTableId: ShortIdSchema,
    sourceFieldId: ShortIdSchema,
    config: z.record(z.string(), z.unknown()),
  })
  .strict();
const PublicFederatedMappingWriteSchema = PublicFederatedMappingSchema.extend({
  config: z.record(z.string(), z.unknown()).optional(),
});
export const PublicFederatedDraftInputSchema = z
  .object({
    sourceTableIds: z.array(ShortIdSchema).max(50),
    mappings: z.array(PublicFederatedMappingWriteSchema).max(10_000),
  })
  .strict();
