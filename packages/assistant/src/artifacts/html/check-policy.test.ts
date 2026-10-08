import { expect, spyOn, test } from "bun:test";
import { aiConversations } from "@k2b/cloud/ai";
import * as capabilityClient from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { defineCapabilities } from "@k2b/cloud/contracts";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { runtimeCapabilities } from "../capability-runtime";
import { testIdentity } from "../test-identity";
import { CHECK_UNAVAILABLE } from "./check-contracts";

test("checks run granted queries but never prepare, review or execute capability effects", async () => {
  const identity = testIdentity("00000000-0000-4000-8000-000000000001");
  const conversationId = "00000000-0000-4000-8000-000000000002";
  const conversation = spyOn(aiConversations, "getConversation").mockResolvedValue({
    id: conversationId,
    shortId: "Chat23",
    title: "Check",
    titleSource: "user",
    description: "",
    descriptionSource: "user",
    keywords: [],
    pinnedAt: null,
    done: null,
    isDone: false,
    lastUsedAt: new Date().toISOString(),
    archivedAt: null,
    runStatus: "idle",
    runError: null,
    unreadCompletion: false,
    projectId: null,
    draft: { content: [], revision: 1, updatedAt: null },
    createdByUserId: identity.user.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const manifest = compileCapabilityManifest(
    "demo",
    defineCapabilities({
      protocolVersion: 2,
      queries: {
        read: {
          title: "Read",
          description: "Read records",
          input: z.object({}).strict(),
          data: z.unknown(),
          openWorld: false,
          run: async () => ok({ data: { answer: 42 } }),
        },
      },
      actions: {
        write: {
          title: "Write",
          description: "Write records",
          input: z.object({}).strict(),
          data: z.unknown(),
          approval: "none",
          idempotency: "none",
          destructive: false,
          openWorld: false,
          run: async () => ok({ data: {} }),
        },
      },
    }),
  );
  const catalog = spyOn(capabilityClient, "getCapabilityCatalogApp").mockResolvedValue({
    ok: true,
    data: { appId: "demo", appName: "Demo", appDescription: "", appIcon: "ti ti-app-window", manifest },
  });
  const prepare = spyOn(runtimeCapabilities, "prepare").mockResolvedValue({
    status: "completed",
    result: { ok: true, data: { answer: 42 } },
  });
  const review = spyOn(capabilityClient, "reviewCapabilityAction");
  const invoke = spyOn(capabilityClient, "invokeCapability");
  try {
    await expect(runtimeCapabilities.check({ name: "demo.write", input: {}, conversationId }, identity, {})).rejects.toMatchObject({
      code: "unavailable",
      message: CHECK_UNAVAILABLE,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(await runtimeCapabilities.check({ name: "demo.read", input: {}, conversationId }, identity, {})).toEqual({ answer: 42 });
    expect(prepare).toHaveBeenCalledTimes(1);
  } finally {
    conversation.mockRestore();
    catalog.mockRestore();
    prepare.mockRestore();
    review.mockRestore();
    invoke.mockRestore();
  }
});
