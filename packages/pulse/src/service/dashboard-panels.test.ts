import { expect, test } from "bun:test";
import { createDashboardPanels, panelShowsCountries } from "./dashboard-panels";

test("a published link reads preset ranges only", async () => {
  const result = await createDashboardPanels()({
    token: "t".repeat(43),
    panelId: "visits",
    range: { range: "24h", from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" },
  });
  expect(result).toMatchObject({ ok: false, error: { status: 400 } });
});

test("maps and panels reading a country dimension may show DB-IP results", () => {
  const sql = "SELECT path, count() AS visits FROM events GROUP BY path";
  expect(panelShowsCountries({ kind: "map", sql })).toBe(true);
  expect(panelShowsCountries({ kind: "table", sql: "SELECT dimensions['country'] AS land, count() AS n FROM events GROUP BY land" })).toBe(
    true,
  );
  expect(panelShowsCountries({ kind: "table", sql })).toBe(false);
});
