import { expect, test } from "bun:test";
import { geoTestConfig } from "../geo/geo.test-fixture";
import { GEO_PLANS, geoPlan } from "../geo/settings";
import { CORE_SETTINGS } from "./core-settings";
import { resolveSettingPresentation, toLegacySettingDefs } from "./defaults";

test("geo settings have en/de labels/help and no endpoint setting", () => {
  const defs = toLegacySettingDefs(CORE_SETTINGS).filter((def) => def.key.startsWith("geo."));
  expect(defs).toHaveLength(6);
  for (const def of defs) {
    const en = resolveSettingPresentation(def, "en"),
      de = resolveSettingPresentation(def, "de");
    expect(de.label).not.toBe(en.label);
    expect(de.description).not.toBe(en.description);
  }
  expect(CORE_SETTINGS["geo.api_key"].kind).toBe("secret");
  expect(CORE_SETTINGS["geo.monthly_budget_credits"].default).toBe(90000);
  expect(CORE_SETTINGS["geo.person_daily_credits"].default).toBe(300);
});
test("plan rates and provider credit allowances match the verified table", () => {
  expect(Object.values(GEO_PLANS).map((p) => [p.dailyCredits, p.rps])).toEqual([
    [3000, 5],
    [10000, 12],
    [25000, 15],
    [50000, 20],
    [100000, 25],
    [250000, 30],
  ]);
  expect(geoPlan({ ...geoTestConfig, plan: "custom", customRps: 7, customDailyCredits: 12345 })).toEqual({ rps: 7, dailyCredits: 12345 });
  expect(geoPlan({ ...geoTestConfig, plan: "free", customRps: 7 })).toEqual({ rps: 5, dailyCredits: 3000 });
});
