import { expect, test } from "bun:test";
import { fixtureDomains } from "./AdminApps.fixture-data";
import { CHECK_INTERVAL_MS, domainHealthy, makePrimaryPlan, nextCheckAt } from "./domains-model";

test("making an alias primary changes redirects in an order the API accepts at every step", () => {
  const domains = [
    ...fixtureDomains(),
    { host: "lager.example.com", redirectTo: "lager.example.de", createdAt: "2026-10-21T09:00:00.000Z", active: true, status: null },
  ];
  // The new primary first, then the old primary's other aliases, the old primary last once nothing points to it.
  expect(makePrimaryPlan(domains, "www.lager.example.de")).toEqual([
    { host: "www.lager.example.de", redirectTo: null },
    { host: "lager.example.com", redirectTo: "www.lager.example.de" },
    { host: "lager.example.de", redirectTo: "www.lager.example.de" },
  ]);
  expect(makePrimaryPlan(domains, "lager.example.de")).toEqual([]);
});

test("a check may run again 60 s after the last result or the last click, whichever is later", () => {
  const [primary, , broken] = fixtureDomains();
  const checked = Date.parse(primary!.status!.checkedAt);
  expect(nextCheckAt(primary!, undefined)).toBe(checked + CHECK_INTERVAL_MS);
  expect(nextCheckAt(primary!, checked + 5000)).toBe(checked + 5000 + CHECK_INTERVAL_MS);
  expect(domainHealthy(primary!)).toBe(true);
  expect(domainHealthy(broken!)).toBe(false);
});
