import { expect, test } from "bun:test";
import { createAdminAiQuotaRoutes } from "./admin-ai-quotas";
import { AiQuotaConfigSchema } from "../shared/ai-quotas";
test("all quota reads and mutations require administrator authentication", async () => {
  const app = createAdminAiQuotaRoutes();
  for (const [path, method] of [
    ["/", "GET"],
    ["/", "PUT"],
    ["/models", "GET"],
    ["/users", "GET"],
    ["/report", "GET"],
    ["/balance", "GET"],
    ["/reset", "POST"],
  ] as const)
    expect((await app.request(path, { method })).status).toBe(401);
});
test("reject invalid quota values, duplicate scopes and public grants", () => {
  const rule = {
    scope: "*",
    anchor: "1970-01-01T00:00:00.000Z",
    hours: 168,
    grants: [{ principal: { type: "authenticated" }, limit: null }],
  };
  const config = { enabled: false, revision: 0, rules: [rule] };
  expect(AiQuotaConfigSchema.safeParse(config).success).toBe(true);
  for (const rules of [
    [rule, rule],
    [{ ...rule, hours: 0 }],
    [{ ...rule, grants: [{ principal: { type: "public" }, limit: 10 }] }],
    [{ ...rule, grants: [...rule.grants, ...rule.grants] }],
    [{ ...rule, grants: [{ principal: { type: "authenticated" }, limit: -1 }] }],
  ])
    expect(AiQuotaConfigSchema.safeParse({ ...config, rules }).success).toBe(false);
});
