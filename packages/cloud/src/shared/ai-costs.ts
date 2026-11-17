import { z } from "zod";

/** Reference prices share one accounting unit (EUR recommended). */
export const AiPriceSchema = z.number().finite().nonnegative().max(1_000_000).multipleOf(0.000001);
export const AiModelPricingSchema = z
  .object({
    inputPerMillion: AiPriceSchema,
    outputPerMillion: AiPriceSchema,
    /** Price of input tokens read from the provider cache; omission uses the ordinary input price. */
    cacheReadPerMillion: AiPriceSchema.optional(),
  })
  .strict()
  .transform(({ cacheReadPerMillion, ...price }) => ({
    ...price,
    // Cache prices are hidden in the ordinary price editor. Lowering the input
    // price must remain saveable and use that lower ordinary rate as fallback.
    ...(cacheReadPerMillion !== undefined && cacheReadPerMillion <= price.inputPerMillion ? { cacheReadPerMillion } : {}),
  }));
export type AiModelPricing = z.infer<typeof AiModelPricingSchema>;

/** Explicit free prices are measured as zero and need no spending guard. */
export const hasBillableAiPricing = (pricing: AiModelPricing | undefined | null): boolean =>
  !!pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0);

/** Integer picounits: six decimal places in prices, divided by a million tokens. */
export function aiCostUnits(pricing: AiModelPricing, input: number, output: number, cacheRead = 0): bigint {
  if (![input, output, cacheRead].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error("AI token counts must be nonnegative safe integers.");
  if (cacheRead > input) throw new Error("Cached AI input cannot exceed total input.");
  const prices = AiModelPricingSchema.parse(pricing);
  return (
    BigInt(Math.round(prices.inputPerMillion * 1_000_000)) * BigInt(input - cacheRead) +
    BigInt(Math.round((prices.cacheReadPerMillion ?? prices.inputPerMillion) * 1_000_000)) * BigInt(cacheRead) +
    BigInt(Math.round(prices.outputPerMillion * 1_000_000)) * BigInt(output)
  );
}

/** Exact decimal for PostgreSQL NUMERIC; aggregate before converting for display. */
export function aiCostDecimal(units: bigint): string {
  return `${units / 1_000_000_000_000n}.${(units % 1_000_000_000_000n).toString().padStart(12, "0")}`;
}

export const aiReferenceCost = (pricing: AiModelPricing, input: number, output: number) =>
  Number(aiCostDecimal(aiCostUnits(pricing, input, output)));

export function aiDecimalUnits(value: string): bigint {
  if (!/^\d+(?:\.\d{1,12})?$/.test(value)) throw new Error("Invalid AI cost decimal.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0"));
}

export const aiBudgetUnits = (value: number) => aiCostUnits({ inputPerMillion: value, outputPerMillion: 0 }, 1_000_000, 0);
