import { describe, expect, test } from "bun:test";
import { dashboardWidgetRequestHeaders } from "./widget-request";

describe("dashboard widget request metadata", () => {
  test("forwards the resolved locale alongside the authenticated session", () => {
    const headers = dashboardWidgetRequestHeaders("session=abc", "de-CH");
    expect(headers.get("x-cloud-locale")).toBe("de-CH");
    expect(headers.get("Cookie")).toBe("session=abc");
    expect(headers.get("Accept-Language")).toBeNull();
  });

  test("forwards locale without inventing a session", () => {
    const headers = dashboardWidgetRequestHeaders("", "en");
    expect(headers.get("x-cloud-locale")).toBe("en");
    expect(headers.get("Cookie")).toBeNull();
  });
});
