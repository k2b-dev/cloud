import { redis } from "bun";
import * as platformSettings from "../services/settings";
import { expect, spyOn, test } from "bun:test";
import * as models from "./assistant-models";
import * as settings from "./settings";
import type { AiModelProfile } from "./types";
import { getAiChatQuotas } from "./chat-quotas";
import { aiQuotas } from "./quotas";
import { aiRoutes } from "./routes";
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
test("own cost view includes its unit and only visible unpriced models; zero prices remain priced", async () => {
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
    expect(result.unit).toBe("points");
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
