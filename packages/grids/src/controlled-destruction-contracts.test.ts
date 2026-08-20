import { describe, expect, test } from "bun:test";
import { CONTROLLED_DESTRUCTION_BATCH_MAX, StartControlledDestructionInputSchema } from "./controlled-destruction-contracts";

const fileIds = (count: number) => Array.from({ length: count }, (_, index) => `F${index.toString(36).padStart(5, "0")}`);

describe("controlled destruction contracts", () => {
  test("accepts one exact bounded selection and rejects overflow or duplicates", () => {
    const input = {
      confirmation: "Example Base",
      fileIds: fileIds(CONTROLLED_DESTRUCTION_BATCH_MAX),
    };
    expect(StartControlledDestructionInputSchema.safeParse(input).success).toBe(true);
    expect(
      StartControlledDestructionInputSchema.safeParse({ ...input, fileIds: fileIds(CONTROLLED_DESTRUCTION_BATCH_MAX + 1) }).success,
    ).toBe(false);
    expect(StartControlledDestructionInputSchema.safeParse({ ...input, fileIds: ["F00000", "F00000"] }).success).toBe(false);
  });
});
