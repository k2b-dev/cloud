import { describe, expect, test } from "bun:test";
import { dashboardMessages } from "./messages";

describe("Dashboard message catalog", () => {
  test("keeps the base chrome complete and falls back for regional requests", () => {
    expect(dashboardMessages.check()).toEqual([]);
    expect(dashboardMessages.resolve(["de-CH"]).t.widgetUnavailable).toBe("Widget nicht verfügbar");
  });
});
