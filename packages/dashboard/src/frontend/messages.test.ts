import { describe, expect, test } from "bun:test";
import { dashboardMessages } from "./messages";

describe("Dashboard message catalog", () => {
  test("keeps the base chrome complete and falls back for regional requests", () => {
    expect(dashboardMessages.check()).toEqual([]);
    expect(dashboardMessages.resolve(["de-CH"]).t.widgetTimeout({ app: "Spaces" })).toBe("Spaces antwortet gerade nicht.");
  });

  test("names the admin app like the platform app menu", () => {
    expect(dashboardMessages.resolve(["en"]).t.adminName).toBe("Admin");
    expect(dashboardMessages.resolve(["de"]).t.adminName).toBe("Administration");
  });
});
