import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { redis as cacheClient } from "bun";
import * as settingsStore from "../settings/store";
import * as redis from "../request-cache-redis";
import { readGeoConfig } from "./settings";
import { GEO_TEST_KEY } from "./geo.test-fixture";

const values: Record<string, unknown> = {
  "geo.api_key": GEO_TEST_KEY,
  "geo.plan": "free",
  "geo.custom_rps": 5,
  "geo.custom_daily_credits": 3000,
  "geo.monthly_budget_credits": 90000,
  "geo.person_daily_credits": 300,
  "app.timezone": "Europe/Berlin",
};
afterEach(() => mock.restore());
test("geo configuration uses stored-state reads and never the shared cache", async () => {
  const read = spyOn(settingsStore, "readStates").mockImplementation(
    async (keys) => new Map(keys.map((key) => [key, { stored: "readable" as const, value: values[key] }])),
  );
  const cache = spyOn(redis, "requestCacheRedis").mockRejectedValue(new Error("No cache access permitted"));
  expect((await readGeoConfig()).apiKey).toBe(GEO_TEST_KEY);
  expect(read).toHaveBeenCalledTimes(1);
  expect(cache).not.toHaveBeenCalled();
});
test("every unreadable geo setting disables configuration and warns with keys only", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const read = spyOn(settingsStore, "readStates");
  for (const unreadable of Object.keys(values).filter((key) => key.startsWith("geo."))) {
    read.mockImplementation(
      async (keys) => new Map(keys.map((key) => [key, { stored: key === unreadable ? "unreadable" : "readable", value: values[key] }])),
    );
    warn.mockClear();
    expect((await readGeoConfig()).apiKey).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(["[geo] Unreadable settings; geo is not configured", { keys: [unreadable] }]);
  }
  read.mockImplementation(
    async (keys) => new Map(keys.map((key) => [key, { stored: key.startsWith("geo.") ? "unreadable" : "readable", value: values[key] }])),
  );
  warn.mockClear();
  expect((await readGeoConfig()).apiKey).toBe("");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[1]).toEqual({ keys: Object.keys(values).filter((key) => key.startsWith("geo.")) });
});
test("warm generic settings reads include the provider key in one cache read without Postgres", async () => {
  const cache = spyOn(redis, "requestCacheRedis").mockResolvedValue(cacheClient);
  const mget = spyOn(cacheClient, "mget").mockResolvedValue([JSON.stringify(GEO_TEST_KEY), JSON.stringify("Cloud")]);
  const state = spyOn(settingsStore, "readKeyState").mockRejectedValue(new Error("No direct DB access permitted"));
  expect(await settingsStore.bulkRead(["geo.api_key", "app.name"])).toEqual(
    new Map([
      ["geo.api_key", GEO_TEST_KEY],
      ["app.name", "Cloud"],
    ]),
  );
  expect(mget).toHaveBeenCalledWith("settings:geo.api_key", "settings:app.name");
  expect(mget).toHaveBeenCalledTimes(1);
  expect(cache).toHaveBeenCalledTimes(1);
  expect(state).not.toHaveBeenCalled();
});
