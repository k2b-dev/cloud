import { expect, test } from "bun:test";
import { resolveDashboardControls } from "./dashboard-controls";
import { compilePulseQueryText } from "./query-dsl";

test("compiler and runtime controls quote the same untrusted values", () => {
  const text = "events page.viewed since $range where route=$route";
  const controls = [
    { variable: "range", defaultValue: "1h" },
    { variable: "route", defaultValue: "/" },
  ];
  const resolved = resolveDashboardControls(text, controls, { route: 'a" since 90d where host=x' });
  const query = compilePulseQueryText("base", resolved);
  expect(query.ok).toBe(true);
  if (query.ok) expect(query.data).toMatchObject({ since: "1h", dimensions: { route: 'a" since 90d where host=x' } });
  expect(resolveDashboardControls("$rangeSuffix $range", controls)).toBe("$rangeSuffix 1h");
});
test("apostrophes are quoted as query values", () => {
  const result = compilePulseQueryText(
    "base",
    resolveDashboardControls("events test since 1h where label=$label", [{ variable: "label", defaultValue: "O'Reilly" }]),
  );
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.data.dimensions).toEqual({ label: "O'Reilly" });
});
