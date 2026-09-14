import { expect, spyOn, test } from "bun:test";
import * as models from "./assistant-models";
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
  bypassed: false,
});
test("quota endpoint requires authentication", async () => {
  expect((await aiRoutes.request("/quotas")).status).toBe(401);
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
  } finally {
    config.mockRestore();
    available.mockRestore();
    snapshot.mockRestore();
  }
});
