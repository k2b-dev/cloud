import { describe, expect, test } from "bun:test";
import { createAdminAiUsageRoutes } from "./admin-ai-usage";
import { aiUsage } from "../ai/usage";

describe("AI usage HTTP boundary", () => {
  test("requires admin authentication on every read", async () => {
    const app = createAdminAiUsageRoutes();
    for (const path of ["/report", "/facets?field=userId", "/runs/background/11111111-1111-4111-8111-111111111111"]) {
      expect((await app.request(path)).status).toBe(401);
    }
  });
  test("validates filters and page budgets before invoking the service", async () => {
    let calls = 0;
    const app = createAdminAiUsageRoutes(async (_c, next) => next(), {
      ...aiUsage,
      facets: async () => {
        calls++;
        return [];
      },
    });
    for (const query of [
      "field=userId&userId=not-an-id",
      "field=userId&perPage=101",
      "field=userId&page=-1",
      "field=userId&until=invalid",
      "field=userId&status=bogus",
    ]) {
      expect((await app.request(`/facets?${query}`)).status).toBe(400);
    }
    expect(calls).toBe(0);
    expect((await app.request("/facets?field=userId&range=7d")).status).toBe(200);
    expect(calls).toBe(1);
  });
  test("serves stored run details and returns 404 for absent records", async () => {
    const app = createAdminAiUsageRoutes(async (_c, next) => next(), { ...aiUsage, detail: async () => null });
    expect((await app.request("/runs/tool/11111111-1111-4111-8111-111111111111")).status).toBe(404);
    expect((await app.request("/runs/tool/not-a-uuid")).status).toBe(400);
    expect((await app.request("/runs/invalid/11111111-1111-4111-8111-111111111111")).status).toBe(400);
  });
});
