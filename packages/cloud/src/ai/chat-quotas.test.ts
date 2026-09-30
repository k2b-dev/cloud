import { expect, spyOn, test } from "bun:test";
import { redis } from "bun";
import * as platformSettings from "../services/settings";
import * as models from "./assistant-models";
import { getAiChatQuotas } from "./chat-quotas";
import { aiQuotas } from "./quotas";
import { aiRoutes } from "./routes";
import * as settings from "./settings";
import type { AiModelProfile } from "./types";

const subject = { type: "user" as const, userId: "own-user" };
const balance = (scope: string) => ({
  scope,
  limit: 100,
  input: 30,
  output: 10,
  used: 40,
  unknown: 0,
  resetsAt: "2026-10-01T00:00:00Z",
  sources: ["Private group"],
  sourceDetails: [{ principal: { type: "group" as const, groupId: "private-group" }, displayName: "Private group" }],
  bypassed: false,
});
test("quota endpoint requires authentication", async () => {
  const config = spyOn(platformSettings, "get").mockResolvedValue(100);
  const counter = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  try {
    const response = await aiRoutes.request("/quotas");
    expect(response.status).toBe(401);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(counter).toHaveBeenCalledTimes(1);
    expect(counter.mock.calls[0]?.[0]).toBe("EVAL");
  } finally {
    config.mockRestore();
    counter.mockRestore();
  }
});
test("disabled quotas skip account and usage queries", async () => {
  const config = spyOn(aiQuotas, "config").mockResolvedValue({ enabled: false, revision: 0, rules: [] });
  const snapshot = spyOn(aiQuotas, "snapshot");
  try {
    expect(await getAiChatQuotas(subject)).toEqual({ enabled: false, balances: [] });
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    config.mockRestore();
    snapshot.mockRestore();
  }
});
test("own view strips grant identities, history and inaccessible model scopes", async () => {
  const config = spyOn(aiQuotas, "config").mockResolvedValue({ enabled: true, revision: 0, rules: [] });
  const available = spyOn(models, "listAssistantAiModels").mockResolvedValue([]);
  const configured = spyOn(settings, "readAiSettingsState").mockResolvedValue({
    ok: true,
    enabled: true,
    profiles: [],
    defaultModelId: "",
    globalInstructions: "",
    compactionInstructions: "",
    maxToolResultChars: 1000,
    firecrawlConfigured: false,
  });
  const snapshot = spyOn(aiQuotas, "snapshot").mockResolvedValue({
    enabled: true,
    balances: [balance("*"), balance("private-model")],
    usage: [{ model: "private-model", input: 30, output: 10, unknown: 0 }],
  });
  try {
    const result = await getAiChatQuotas(subject);
    expect(snapshot).toHaveBeenCalledWith(subject);
    expect(result.balances.map((b) => b.scope)).toEqual(["*"]);
    expect(JSON.stringify(result)).not.toContain("Private group");
    expect(result).not.toHaveProperty("usage");
    expect(result.balances[0]).not.toHaveProperty("sourceDetails");
  } finally {
    config.mockRestore();
    available.mockRestore();
    configured.mockRestore();
    snapshot.mockRestore();
  }
});
test("own view marks visible unpriced models as unlimited; zero prices remain priced", async () => {
  const profile = (id: string, pricing?: AiModelProfile["pricing"]): AiModelProfile => ({
    id,
    label: id,
    provider: "ollama",
    model: id,
    enabled: true,
    capabilities: ["streaming"],
    dataBoundary: "private",
    pricing,
  });
  const config = spyOn(aiQuotas, "config").mockResolvedValue({ enabled: true, revision: 0, rules: [], unit: "points" });
  const available = spyOn(models, "listAssistantAiModels").mockResolvedValue([profile("unpriced"), profile("free")]);
  const configured = spyOn(settings, "readAiSettingsState").mockResolvedValue({
    ok: true,
    enabled: true,
    profiles: [profile("unpriced"), profile("free", { inputPerMillion: 0, outputPerMillion: 0 }), profile("secret")],
    defaultModelId: "free",
    globalInstructions: "",
    compactionInstructions: "",
    maxToolResultChars: 1000,
    firecrawlConfigured: false,
  });
  const snapshot = spyOn(aiQuotas, "snapshot").mockResolvedValue({ enabled: true, balances: [balance("*"), balance("secret")], usage: [] });
  try {
    const result = await getAiChatQuotas(subject);
    expect(result.unlimitedModels).toEqual(["unpriced", "free"]);
    expect(result.balances.map((b) => b.scope)).toEqual(["*"]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("Private group");
  } finally {
    config.mockRestore();
    available.mockRestore();
    configured.mockRestore();
    snapshot.mockRestore();
  }
});
test("own view carries usage shares only: no amounts, limits, or unit", async () => {
  const model = (id: string): AiModelProfile => ({
    id,
    label: id,
    provider: "ollama",
    model: id,
    enabled: true,
    capabilities: ["streaming"],
    dataBoundary: "private",
    pricing: { inputPerMillion: 3, outputPerMillion: 15 },
  });
  const ids = ["near", "over", "zero", "open", "skipped", "unmeasured"];
  const config = spyOn(aiQuotas, "config").mockResolvedValue({ enabled: true, revision: 0, rules: [], unit: "EUR" });
  const available = spyOn(models, "listAssistantAiModels").mockResolvedValue(ids.map(model));
  const configured = spyOn(settings, "readAiSettingsState").mockResolvedValue({
    ok: true,
    enabled: true,
    profiles: ids.map(model),
    defaultModelId: "near",
    globalInstructions: "",
    compactionInstructions: "",
    maxToolResultChars: 1000,
    firecrawlConfigured: false,
  });
  const snapshot = spyOn(aiQuotas, "snapshot").mockResolvedValue({
    enabled: true,
    unit: "EUR",
    balances: [
      { ...balance("*"), limit: 5.25, used: 1.8375, input: 1.25, output: 0.5875, estimated: 2 },
      { ...balance("near"), limit: 5.25, used: 5.2499 },
      { ...balance("over"), limit: 5.25, used: 7.75 },
      { ...balance("zero"), limit: 0, used: 0 },
      { ...balance("open"), limit: null, used: 7.75 },
      { ...balance("skipped"), limit: 5.25, used: 7.75, bypassed: true },
      { ...balance("unmeasured"), limit: 5.25, used: 1.8375, unknown: 3 },
    ],
    usage: [{ model: "near", input: 1.25, output: 0.5875, unknown: 0 }],
  });
  try {
    const result = await getAiChatQuotas(subject);
    const resetsAt = "2026-10-01T00:00:00Z";
    expect(result).toEqual({
      enabled: true,
      unlimitedModels: [],
      balances: [
        { scope: "*", unlimited: false, usedPercent: 35, resetsAt },
        // Only a used-up allowance reads 100, so "used up" never shows while calls are still admitted.
        // Admission can reject earlier, when the rest cannot cover the next call.
        { scope: "near", unlimited: false, usedPercent: 99, resetsAt },
        { scope: "over", unlimited: false, usedPercent: 100, resetsAt },
        { scope: "zero", unlimited: false, usedPercent: 100, resetsAt },
        { scope: "open", unlimited: true, usedPercent: null, resetsAt: null },
        { scope: "skipped", unlimited: true, usedPercent: null, resetsAt: null },
        { scope: "unmeasured", unlimited: false, usedPercent: null, resetsAt },
      ],
    });
    const wire = JSON.stringify(result);
    for (const money of ["EUR", "unit", '"limit"', '"used"', "input", "output", "estimated", "5.25", "1.8375", "7.75", "0.5875"])
      expect(wire).not.toContain(money);
  } finally {
    config.mockRestore();
    available.mockRestore();
    configured.mockRestore();
    snapshot.mockRestore();
  }
});
