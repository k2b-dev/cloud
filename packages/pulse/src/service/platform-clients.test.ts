import { expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { baseStore } from "../store/base-store";
import { createHourlyRollup } from "./metric-rollups";

useUnitClients();
// Construct before the fixture selects clients, as the exported singletons do.
const store = { ...baseStore, prepare: async () => baseStore.query };
const rollup = createHourlyRollup({ store });

test.each(["first target", "replacement target"])(
  "a rollup created before startup resolves the current transaction client: %s",
  async () => {
    const failure = new Error("current platform transaction");
    const begin = spyOn(sql, "begin").mockRejectedValue(failure);
    try {
      await expect(rollup()).rejects.toBe(failure);
      expect(begin).toHaveBeenCalledTimes(1);
    } finally {
      begin.mockRestore();
    }
  },
);
