import { afterEach, expect, spyOn, test } from "bun:test";
import * as cloudAi from "@k2b/cloud/ai";
import { aiConversations } from "@k2b/cloud/ai";
import type { RequestActor } from "@k2b/cloud/server";
import { clientCalls } from "./client-calls";
import { testIdentity } from "./test-identity";

const owner = testIdentity("00000000-0000-4000-8000-000000000001");
const appActor: RequestActor = { kind: "user", user: owner.user, sessionKind: "app" };
const appSession = { ...owner, actor: appActor };
const conversationId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const input = { operation: "secret" as const, name: "API", origin: "https://api.example.com", prefix: "" };
const call = { conversationId, turnId, callId: "secret-call", clientId: "11111111-1111-4111-8111-111111111111", input };
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** A live `code_secret` call in a turn that `startedBy` started. */
const liveSecretCall = (startedBy: RequestActor | undefined) => {
  spies.push(
    spyOn(aiConversations, "getConversation").mockResolvedValue({
      id: conversationId,
      shortId: "abcdef",
      title: "Test",
      titleSource: "user",
      description: "",
      descriptionSource: "user",
      keywords: [],
      pinnedAt: null,
      done: null,
      isDone: false,
      lastUsedAt: "2026-11-20T00:00:00.000Z",
      archivedAt: null,
      runStatus: "needs_attention",
      runError: null,
      unreadCompletion: false,
      projectId: null,
      draft: { content: [], revision: 1, updatedAt: null },
      createdByUserId: owner.user.id,
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
    }),
    spyOn(aiConversations, "getActiveTurn").mockResolvedValue({
      turn: {
        id: turnId,
        shortId: "ghijkl",
        conversationId,
        status: "waiting_for_action",
        attempt: 1,
        modelId: null,
        createdAt: "2026-11-20T00:00:00.000Z",
        completedAt: null,
        error: null,
      },
      liveBlocks: [
        {
          id: "block",
          kind: "tool",
          callId: call.callId,
          name: "code_secret",
          args: { name: input.name, origin: input.origin, prefix: input.prefix },
          status: "awaiting_client",
          frontendMode: "client",
        },
      ],
      liveSeq: 1,
      actionWaitMs: 0,
      waitingSince: null,
    }),
    spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue({ input: "Store the key", actor: startedBy }),
  );
  const started = spyOn(cloudAi.aiToolAudit, "noteToolStarted").mockResolvedValue(true);
  spies.push(started);
  return started;
};

for (const [name, startedBy] of [
  ["the browser", owner.actor],
  ["an unknown client", undefined],
] as const)
  test(`an app session cannot claim or answer a secret request in a turn started by ${name}`, async () => {
    const started = liveSecretCall(startedBy);
    await expect(clientCalls.claim(call, appSession)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(clientCalls.complete({ ...call, result: { configured: true, name: "API" } }, appSession)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    // Refused before the call starts, so no card, lease or save follows in the app.
    expect(started).not.toHaveBeenCalled();
  });
