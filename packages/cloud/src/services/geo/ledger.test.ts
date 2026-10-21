import { expect, test } from "bun:test";
import { geoPeriods, geoSubjectKey } from "./ledger";

test("calendar day and month roll in app.timezone, including DST", () => {
  const before = new Date("2026-10-31T22:59:59.999Z"),
    after = new Date("2026-10-31T23:00:00.000Z");
  expect(geoPeriods(before, "Europe/Berlin")).toEqual({
    person: { period: "2026-10-31", resetsAt: after.toISOString() },
    cloud: { period: "2026-10", resetsAt: after.toISOString() },
  });
  expect(geoPeriods(after, "Europe/Berlin").cloud.period).toBe("2026-11");
  expect(geoPeriods(after, "UTC").cloud.period).toBe("2026-10");
  expect(geoPeriods(new Date("2026-03-29T00:00:00.000Z"), "Europe/Berlin").person.resetsAt).toBe("2026-03-29T22:00:00.000Z");
  expect(geoPeriods(new Date("2026-10-24T22:00:00.000Z"), "Europe/Berlin").person.resetsAt).toBe("2026-10-25T23:00:00.000Z");
});
test("subject keys use principal kind and opaque id, delegated sessions keep their access subject", () => {
  expect(geoSubjectKey({ type: "user", userId: "opaque-id", delegatedByServiceAccountId: "delegate" })).toBe("user:opaque-id");
  expect(geoSubjectKey({ type: "service_account", serviceAccountId: "opaque-id" })).toBe("service_account:opaque-id");
});
