import { expect, spyOn, test } from "bun:test";
import { aiConversations } from "@k2b/cloud/ai";
import { hostFetch } from "./agent-host";
import { appChecks } from "./html/check-service";
import { testIdentity } from "./test-identity";

test("a cancelled turn can discard only its host's own scratch scopes", async () => {
  const context = {
    ...testIdentity("00000000-0000-4000-8000-000000000001"),
    conversationId: "00000000-0000-4000-8000-000000000002",
    locale: "en",
    timeZone: "UTC",
    signal: new AbortController().signal,
  };
  const session: Parameters<typeof hostFetch>[1] = {
    phase: "running",
    id: crypto.randomUUID(),
    key: context.conversationId,
    conversationId: context.conversationId,
    turnId: crypto.randomUUID(),
    background: false,
    context,
    lastUsed: Date.now(),
    busy: new Set(),
    checks: new Map(),
    checkScopes: new Set(["Scp234"]),
    decisions: new Map(),
    capabilityTransport: async () => {
      throw new Error("Unexpected capability");
    },
    host: Promise.resolve({ health: async () => {}, execute: async () => null, call: async () => null, close: async () => {} }),
  };
  const authorization = spyOn(aiConversations, "getConversation").mockRejectedValue(new Error("Execution authorization revoked"));
  const turn = spyOn(aiConversations, "getTurn").mockResolvedValue(null);
  const config = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue(null);
  const discard = spyOn(appChecks, "discard").mockResolvedValue(undefined);
  const request = (id: string) =>
    hostFetch(context, session, "/api/assistant/artifacts/runtime/check/discard", {
      method: "POST",
      body: JSON.stringify({ id }),
      headers: { "content-type": "application/json" },
    });
  try {
    expect(await (await request("Scp234")).json()).toEqual({ discarded: true });
    expect(authorization).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith("Scp234", context);
    expect(session.checkScopes.size).toBe(0);
    await expect(request("App234")).rejects.toThrow("Execution authorization revoked");
    expect(discard).toHaveBeenCalledTimes(1);
  } finally {
    authorization.mockRestore();
    turn.mockRestore();
    config.mockRestore();
    discard.mockRestore();
  }
});
