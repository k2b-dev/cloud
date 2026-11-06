import { expect, spyOn, test } from "bun:test";
import type { StoreRow } from "./base-store";
import * as stores from "./base-store";
import { retentionPreview } from "./retention";

const baseId = "11111111-1111-4111-8111-111111111111";
const row: StoreRow = {
  base_id: baseId,
  state: "active",
  operation: null,
  database_name: "pulse_11111111111141118111111111111111",
  read_user: "pulse_r_11111111111141118111111111111111",
  read_password_encrypted: null,
  profile: "normal",
  schema_version: 1,
  updated_at_version: "2026-10-17 12:00:00+00",
  retention_days: 30,
  rollup_retention_days: 365,
  sensitive_retention_hours: 24,
  reset_generation: "0",
  checkpoint_id: null,
  pending_checkpoint_id: null,
  write_block_reason: null,
};

test("sensitive preview counts only nonempty expired fields and their own size", async () => {
  const load = spyOn(stores, "loadStoreRow").mockResolvedValue(row);
  const queries: string[] = [];
  const store = {
    ...stores.baseStore,
    query: async (query: string) => {
      queries.push(query);
      // Two expired non-empty sensitive fields with 14 bytes together; whole-row sizes must not enter the estimate.
      if (query.includes("AND sensitive != ''")) return [{ rows: 2, bytes: 14 }];
      return [{ rows: 5, bytes: 10_000 }];
    },
  };
  try {
    expect(
      await retentionPreview(
        baseId,
        row,
        { rawRetentionDays: 30, rollupRetentionDays: 365, sensitiveRetentionHours: 1 },
        () => new Date("2026-10-17T12:00:00.000Z"),
        store,
      ),
    ).toEqual([{ kind: "sensitive", retention: 1, cutoff: "2026-10-17T11:00:00.000Z", rows: 2, bytes: 14 }]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("sum(length(sensitive))");
  } finally {
    load.mockRestore();
  }
});
