import { describe, expect, test } from "bun:test";
import { internalDashboardSourceId } from "./public-dashboard-snapshot";

describe("Pulse dashboard source IDs", () => {
  test("rejects missing sources instead of broadening or hiding the filter", () => {
    const validInternalId = "00000000-0000-4000-8000-000000000001";
    const sources = new Map([["Src001", validInternalId]]);

    expect(internalDashboardSourceId(sources, "Src001")).toBe(validInternalId);
    expect(() => internalDashboardSourceId(sources, "Gone01")).toThrow();
    expect(internalDashboardSourceId(sources, null)).toBeNull();
  });
});
