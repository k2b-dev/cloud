import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as settingsStore from "../settings/store";
import * as redis from "../request-cache-redis";
import { readGeoConfig } from "./settings";
import { GEO_TEST_KEY } from "./geo.test-fixture";

afterEach(() => mock.restore());
test("geo configuration uses stored-state reads and never the shared cache", async () => {
  const values: Record<string, unknown> = {
    "geo.api_key": GEO_TEST_KEY,
    "geo.plan": "free",
    "geo.custom_rps": 5,
    "geo.custom_daily_credits": 3000,
    "geo.monthly_budget_credits": 90000,
    "geo.person_daily_credits": 300,
    "app.timezone": "Europe/Berlin",
  };
  const read = spyOn(settingsStore, "readStates").mockImplementation(
    async (keys) => new Map(keys.map((key) => [key, { stored: "readable" as const, value: values[key] }])),
  );
  const cache = spyOn(redis, "requestCacheRedis").mockRejectedValue(new Error("No cache access permitted"));
  expect((await readGeoConfig()).apiKey).toBe(GEO_TEST_KEY);
  expect(read).toHaveBeenCalledTimes(1);
  expect(cache).not.toHaveBeenCalled();
});
test("generic setting reads also keep the provider key out of Valkey", async () => {
  spyOn(settingsStore, "readKeyState").mockResolvedValue({ stored: "readable", value: GEO_TEST_KEY });
  const cache = spyOn(redis, "requestCacheRedis").mockRejectedValue(new Error("No cache access permitted"));
  expect((await settingsStore.bulkRead(["geo.api_key"])).get("geo.api_key")).toBe(GEO_TEST_KEY);
  expect(cache).not.toHaveBeenCalled();
});
