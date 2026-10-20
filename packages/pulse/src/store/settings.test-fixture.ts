import { spyOn } from "bun:test";
import { app } from "../config";
export const settingsFixture = () => {
  const values = {
    "pulse.clickhouse_connection": "",
    "pulse.base_creation": "everyone",
    "pulse.max_bases": 200,
    "pulse.max_raw_retention_days": 730,
    "pulse.default_profile": "normal",
    "pulse.default_values_per_minute": 2000,
    "pulse.default_bytes_per_minute": 5242880,
    "pulse.default_storage_bytes": 5000000000,
    "pulse.default_max_series": 50000,
    "pulse.default_max_event_kinds": 2000,
    "pulse.default_max_state_keys": 2000,
  };
  const get = spyOn(app.settings, "get").mockImplementation(async (key) => values[key]);
  const set = spyOn(app.settings, "set").mockImplementation(async (key, value) => {
    Object.assign(values, { [key]: value });
  });
  return {
    values,
    restore: () => {
      get.mockRestore();
      set.mockRestore();
    },
  };
};
