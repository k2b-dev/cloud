import { z } from "zod";
import { FormatSpecSchema, ShortIdSchema } from "../contracts";
import { fieldTypeRegistry } from "../field-types";
import { IdStrategyConfigSchema } from "../field-types/system";

// Public resource references differ from the stored UUID configurations.
// Share these contracts between transport validation and CLI discovery.
export const PublicRelationConfigSchema = z.object({
  targetTableId: ShortIdSchema.optional(),
  cardinality: z.enum(["single", "multiple"]).optional(),
});
export const PublicLookupConfigSchema = z.object({
  relationFieldId: ShortIdSchema.optional(),
  targetFieldId: ShortIdSchema.optional(),
  format: FormatSpecSchema.optional(),
});
export const PublicRollupConfigSchema = PublicLookupConfigSchema.extend({
  agg: z.enum(["count", "sum", "avg", "min", "max"]).optional(),
});

export const publicFieldConfigSchema = (type: string) => {
  if (type === "relation") return PublicRelationConfigSchema;
  if (type === "lookup") return PublicLookupConfigSchema;
  if (type === "rollup") return PublicRollupConfigSchema;
  // The input preprocessor also accepts an omitted strategy as sequence.
  // Expose the canonical union rather than an unconstrained preprocess input.
  if (type === "id") return IdStrategyConfigSchema;
  const definition = fieldTypeRegistry[type];
  if (!definition) throw new Error(`Unknown field type "${type}"`);
  return definition.configSchema;
};
