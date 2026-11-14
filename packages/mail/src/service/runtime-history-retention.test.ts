import { describe, expect, test } from "bun:test";
import { cleanupMailRuntimeHistory } from "./runtime-history-retention";

describe("Mail runtime history retention", () => {
  test("rejects invalid retention bounds before querying storage", async () => {
    await expect(cleanupMailRuntimeHistory({ retentionDays: 0 })).rejects.toThrow("Retention days must be a positive integer");
    await expect(cleanupMailRuntimeHistory({ successRetentionDays: 0 })).rejects.toThrow(
      "Success retention days must be a positive integer",
    );
    await expect(cleanupMailRuntimeHistory({ batchSize: 0 })).rejects.toThrow("Batch size must be a positive integer");
    await expect(cleanupMailRuntimeHistory({ maxBatches: 0 })).rejects.toThrow("Max batches must be a positive integer");
    await expect(cleanupMailRuntimeHistory({ maxDurationMs: 0 })).rejects.toThrow("Max duration must be a positive integer");
  });
});
