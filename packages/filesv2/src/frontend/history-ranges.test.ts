import { expect, test } from "bun:test";
import { activityRequest, rangeStart } from "./ActivityView";

test.each([
  ["2026-10-25T12:30:00.123Z", "Europe/Berlin", "2026-10-24T22:00:00.000Z"],
  ["2026-03-29T12:30:00.123Z", "Europe/Berlin", "2026-03-28T23:00:00.000Z"],
  ["2026-10-25T12:30:00.123Z", "UTC", "2026-10-25T00:00:00.000Z"],
  ["2026-03-29T12:30:00.123Z", "UTC", "2026-03-29T00:00:00.000Z"],
])("today starts at actual local midnight for %s in %s", (now, timeZone, expected) => {
  expect(rangeStart("today", { now, timeZone })).toBe(expected);
});

test("Activity keeps exact/default and folder path scopes, including the base folder", () => {
  const env = { now: "2026-10-20T12:30:00.000Z", timeZone: "Europe/Berlin" };
  expect(activityRequest({ baseId: "base", path: "Docs" }, env)).toEqual({ baseId: "base", path: "Docs", scope: "item" });
  expect(activityRequest({ baseId: "base", path: "Docs", scope: "folder" }, env)).toEqual({
    baseId: "base",
    path: "Docs",
    scope: "folder",
  });
  expect(activityRequest({ baseId: "base", path: "", scope: "folder" }, env)).toEqual({ baseId: "base", path: "", scope: "folder" });
});
