import { expect, test } from "bun:test";
import {
  boundGridsSettings,
  GRIDS_SETTINGS_COOKIE_BUDGET,
  parseDocumentViewMode,
  parseNavigationExpansion,
} from "../sidebar/GridsSettingsStore";
import { initialNavigationExpansion } from "./navigation-expansion";

const groups = [{ id: "GROUP1", name: "Work", entries: [{ type: "view" as const, id: "VIEW01" }] }];
test("opens curated groups initially, remembers collapse, and reveals the active destination", () => {
  expect(initialNavigationExpansion(groups, undefined, null, ["view", "table"])).toEqual(["group:GROUP1"]);
  expect(initialNavigationExpansion(groups, [], null, ["view"])).toEqual([]);
  expect(initialNavigationExpansion(groups, [], "view:VIEW01", ["view"])).toEqual(["group:GROUP1"]);
  expect(initialNavigationExpansion(groups, ["group:OLDOLD"], "table:TABLE1", ["table"])).toEqual(["type:table"]);
});
test("bounds the entire encoded cookie and preserves existing document settings", () => {
  const settings = boundGridsSettings({
    lastPath: "/app/grids/BASE01",
    documentViewMode: "folders",
    navigation: Array.from({ length: 200 }, (_, i) => ({ base: String(i).padStart(6, "0"), expanded: ["group:GROUP1", "type:table"] })),
  });
  expect(encodeURIComponent(JSON.stringify(settings)).length).toBeLessThanOrEqual(GRIDS_SETTINGS_COOKIE_BUDGET);
  const header = `settings-app-grids=${encodeURIComponent(JSON.stringify(settings))}`;
  expect(parseNavigationExpansion(header, "000000")).toEqual(["group:GROUP1", "type:table"]);
  expect(parseDocumentViewMode(header)).toBe("folders");
  expect(parseNavigationExpansion("settings-app-grids=%invalid", "BASE01")).toBeUndefined();
  expect(
    parseNavigationExpansion(
      `settings-app-grids=${encodeURIComponent(JSON.stringify({ navigation: [{ base: "BASE01", expanded: ["__proto__", null, "type:view"] }] }))}`,
      "BASE01",
    ),
  ).toEqual(["type:view"]);
});
