import { expect, test } from "bun:test";
import { AiQuotaReportQuerySchema, aiQuotaHref } from "./ai-quotas";

test("quota report URLs preserve cohort and selected account while defaulting to users", () => {
  const q = AiQuotaReportQuerySchema.parse({
    search: "A & B",
    model: "model/a",
    status: "unknown",
    range: "7d",
    direction: "asc",
    page: "2",
    identity: "11111111-1111-4111-8111-111111111111",
  });
  const url = new URL(aiQuotaHref(q), "http://localhost");
  expect(AiQuotaReportQuerySchema.parse(Object.fromEntries(url.searchParams))).toEqual(q);
  expect(q.view).toBe("users");
  for (const invalid of [{ page: 0 }, { direction: "DROP" }, { range: "1y" }, { status: "invented" }, { identity: "invalid" }])
    expect(AiQuotaReportQuerySchema.safeParse(invalid).success).toBe(false);
});
