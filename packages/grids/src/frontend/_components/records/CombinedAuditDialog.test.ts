import { describe, expect, test } from "bun:test";
import "../ssr-test-plugin";

const { combinedAuditDateStart, combinedAuditDayAfter } = await import("./CombinedAuditDialog");

describe("Combined audit date filters", () => {
  test("uses the configured timezone and keeps DST day boundaries exact", () => {
    const dateConfig = { timeZone: "Europe/Berlin" };

    expect(combinedAuditDateStart("2026-03-29", dateConfig)).toBe("2026-03-28T23:00:00.000Z");
    expect(combinedAuditDayAfter("2026-03-29", dateConfig)).toBe("2026-03-29T22:00:00.000Z");
  });

  test("omits empty date filters", () => {
    expect(combinedAuditDateStart("")).toBeUndefined();
    expect(combinedAuditDayAfter("")).toBeUndefined();
  });
});
