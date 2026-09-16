import { expect, test } from "bun:test";
import { createAdminAiQuotaRoutes } from "./admin-ai-quotas";
import { AiQuotaConfigSchema } from "../shared/ai-quotas";
test("all quota reads and mutations require administrator authentication", async () => {
  const app = createAdminAiQuotaRoutes();
  for (const [path, method] of [
    ["/", "GET"],
    ["/", "PUT"],
    ["/models", "GET"],
    ["/models/chat/pricing", "PUT"],
    ["/background", "GET"],
    ["/background/release", "POST"],
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
    hours: 24,
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
test("cost configuration accepts fractional amounts and rejects invalid emergency thresholds", () => {
  const config = {
    enabled: true,
    revision: 0,
    unit: "EUR",
    rules: [{ scope: "*", hours: 24, anchor: "2026-09-16T00:00:00Z", grants: [{ principal: { type: "authenticated" }, limit: 0.125001 }] }],
    background: { enabled: true, warnAt: 2.5, stopAt: 5 },
  };
  expect(AiQuotaConfigSchema.parse(config)).toMatchObject(config);
  expect(AiQuotaConfigSchema.safeParse({ ...config, unit: "internal points" }).success).toBe(true);
  for (const background of [
    { enabled: true, warnAt: 5, stopAt: 5 },
    { enabled: true, warnAt: 6, stopAt: 5 },
    { enabled: true, warnAt: null, stopAt: 0 },
    { enabled: true, warnAt: -1, stopAt: 5 },
  ])
    expect(AiQuotaConfigSchema.safeParse({ ...config, background }).success).toBe(false);
});
