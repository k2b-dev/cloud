import { expect, spyOn, test } from "bun:test";
import { aiQuotas } from "../ai/quotas";
import * as settings from "../ai/settings";
import type { AiModelProfile } from "../ai/types";
import { buildProjectedUser } from "../services/session/user";
import { AiQuotaConfigSchema } from "../shared/ai-quotas";
import { createAdminAiQuotaRoutes } from "./admin-ai-quotas";

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

test("new scopes require active billable chat models while existing scopes stay editable", async () => {
  const model: AiModelProfile = {
    id: "paid",
    label: "Paid",
    provider: "openai",
    model: "chat",
    enabled: true,
    capabilities: ["streaming"],
    dataBoundary: "hosted",
    pricing: { inputPerMillion: 0, outputPerMillion: 1 },
  };
  const profiles = [
    model,
    { ...model, id: "unpriced", pricing: undefined },
    { ...model, id: "free", pricing: { inputPerMillion: 0, outputPerMillion: 0 } },
    { ...model, id: "audio", capabilities: ["transcription" as const] },
    { ...model, id: "disabled", enabled: false },
  ];
  const config = { enabled: true, revision: 0, rules: [] };
  const read = spyOn(settings, "readAiSettingsState").mockResolvedValue({
    ok: true,
    enabled: true,
    defaultModelId: "paid",
    globalInstructions: "",
    compactionInstructions: "",
    maxToolResultChars: 1000,
    firecrawlConfigured: false,
    profiles,
  });
  const current = spyOn(aiQuotas, "config").mockResolvedValue(config);
  const save = spyOn(aiQuotas, "save").mockImplementation(async (value) => value);
  const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: true });
  const app = createAdminAiQuotaRoutes(async (c, next) => {
    c.set("user", user);
    await next();
  });
  const rule = (scope: string) => ({ scope, hours: 24, anchor: "2026-09-16T00:00:00Z", grants: [] });
  const put = (scope: string) =>
    app.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...config, rules: [rule(scope)] }),
    });
  try {
    for (const scope of ["free", "unpriced", "audio", "disabled", "missing"]) expect((await put(scope)).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
    expect((await put("paid")).status).toBe(200);
    expect((await put("*")).status).toBe(200);
    current.mockResolvedValue({ ...config, rules: [rule("free"), rule("missing")] });
    expect((await put("free")).status).toBe(200);
    expect((await put("missing")).status).toBe(200);
  } finally {
    read.mockRestore();
    current.mockRestore();
    save.mockRestore();
  }
});
