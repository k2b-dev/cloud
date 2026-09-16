import { z } from "zod";

/** Reference prices share one accounting unit (EUR recommended). */
export const AiPriceSchema = z.number().finite().nonnegative().max(1_000_000).multipleOf(0.000001);
export const AiModelPricingSchema = z
  .object({
    inputPerMillion: AiPriceSchema,
    outputPerMillion: AiPriceSchema,
  })
  .strict();
export type AiModelPricing = z.infer<typeof AiModelPricingSchema>;

/** Explicit free prices are measured as zero and need no spending guard. */
export const hasBillableAiPricing = (pricing: AiModelPricing | undefined | null): boolean =>
  !!pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0);

/** Integer picounits: six decimal places in prices, divided by a million tokens. */
export function aiCostUnits(pricing: AiModelPricing, input: number, output: number): bigint {
  if (![input, output].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error("AI token counts must be nonnegative safe integers.");
  const prices = AiModelPricingSchema.parse(pricing);
  return (
    BigInt(Math.round(prices.inputPerMillion * 1_000_000)) * BigInt(input) +
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
