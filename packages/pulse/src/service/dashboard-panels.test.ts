import { expect, test } from "bun:test";
import { createDashboardPanels } from "./dashboard-panels";

test("a published link reads preset ranges only", async () => {
  const result = await createDashboardPanels()({
    token: "t".repeat(43),
    panelId: "visits",
    range: { range: "24h", from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" },
  });
  expect(result).toMatchObject({ ok: false, error: { status: 400 } });
});
