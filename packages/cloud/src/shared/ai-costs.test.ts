import { describe, expect, test } from "bun:test";
import { AiModelPricingSchema, aiCostDecimal, aiCostUnits, aiReferenceCost } from "./ai-costs";

describe("AI reference prices", () => {
  test("million-token prices retain sub-cent amounts before aggregation", () => {
    const pricing = { inputPerMillion: 0.123456, outputPerMillion: 1.234567 };
    expect(aiCostDecimal(aiCostUnits(pricing, 1, 1))).toBe("0.000001358023");
    expect(aiReferenceCost(pricing, 1_000_000, 1_000_000)).toBe(1.358023);
    expect(aiCostDecimal(aiCostUnits(pricing, 1, 1) * 1_000_000n)).toBe("1.358023000000");
  });
  test("zero is explicitly priced; incomplete and invalid prices are rejected", () => {
    expect(aiReferenceCost({ inputPerMillion: 0, outputPerMillion: 0 }, 10, 20)).toBe(0);
    for (const value of [
      {},
      { inputPerMillion: 1 },
      { inputPerMillion: -1, outputPerMillion: 0 },
      { inputPerMillion: Infinity, outputPerMillion: 0 },
      { inputPerMillion: 0.0000001, outputPerMillion: 0 },
    ])
      expect(AiModelPricingSchema.safeParse(value).success).toBe(false);
    expect(() => aiCostUnits({ inputPerMillion: 1, outputPerMillion: 1 }, -1, 0)).toThrow();
  });
});

test("cache reads use their configured price exactly once, with a conservative uncached fallback", () => {
  const pricing = { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2 };
  expect(aiCostDecimal(aiCostUnits(pricing, 1_000_000, 100_000, 900_000))).toBe("1.380000000000");
  expect(aiCostDecimal(aiCostUnits(pricing, 1_000_000, 100_000))).toBe("3.000000000000");
  expect(aiCostUnits({ inputPerMillion: 2, outputPerMillion: 10 }, 100, 10, 90)).toBe(
    aiCostUnits({ inputPerMillion: 2, outputPerMillion: 10 }, 100, 10),
  );
  expect(() => aiCostUnits(pricing, 10, 0, 11)).toThrow();
  expect(() => aiCostUnits(pricing, 10, 0, -1)).toThrow();
  expect(AiModelPricingSchema.safeParse({ ...pricing, cacheReadPerMillion: 3 }).success).toBe(false);
});
