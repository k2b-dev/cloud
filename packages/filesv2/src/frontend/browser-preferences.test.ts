import { expect, test } from "bun:test";
import { defaultView, parsePreferences, preferencesCookie, viewFor, withView } from "./browser-preferences";

test("older preference cookies retain sort and view while defaulting to grouped folders", () => {
  const cookie = `${preferencesCookie}=${encodeURIComponent(JSON.stringify({ "cloud:groups:one": { view: "grid", size: "lg", sort: "size", direction: "desc" } }))}`;
  expect(viewFor(parsePreferences(cookie), "cloud:groups:one")).toEqual({ view: "grid", size: "lg", sort: "size", direction: "desc", groupFolders: true, type: "all" });
});

test("folder grouping is remembered independently for complete storage identities", () => {
  const preferences = withView({}, "cloud:groups:one", { ...defaultView, groupFolders: false });
  expect(viewFor(preferences, "cloud:groups:one").groupFolders).toBe(false);
  expect(viewFor(preferences, "cloud:groups:two").groupFolders).toBe(true);
});
