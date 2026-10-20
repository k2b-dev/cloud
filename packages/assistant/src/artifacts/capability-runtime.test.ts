import { expect, spyOn, test } from "bun:test";
import { AiBackgroundApprovalRequiredError, aiChatTasks, aiConversations } from "@k2b/cloud/ai";
import * as capabilityClient from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { defineCapabilities } from "@k2b/cloud/contracts";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { runtimeCapabilities } from "./capability-runtime";
import { testIdentity } from "./test-identity";

for (const outcome of ["no scope", "review throws", "review unavailable", "no review", "mandate denied"] as const) {
  test(`background runtime capability ${outcome} refuses before inserting a call or invoking the app`, async () => {
    const identity = testIdentity("00000000-0000-4000-8000-000000000001");
    const conversationId = "00000000-0000-4000-8000-000000000002";
    const turnId = "00000000-0000-4000-8000-000000000003";
    const mandate = { id: "00000000-0000-4000-8000-000000000004", revision: 1 };
    const manifest = compileCapabilityManifest(
      "demo",
      defineCapabilities({
        protocolVersion: 2,
        actions: {
          write: {
            title: "Aufgabe zuweisen",
            description: "Assign a task.",
            input: z.object({}).strict(),
            data: z.unknown(),
            approval: "rememberable",
            idempotency: "required",
            destructive: false,
            openWorld: false,
            review: async () => ok({ message: "Aufgabe zuweisen?" }),
            run: async () => ok({ data: {} }),
          },
        },
      }),
    );
    if (outcome === "no review") delete manifest.actions[0]!.review;
    const at = "2026-10-18T09:00:00.000Z";
    const conversation = spyOn(aiConversations, "getConversation").mockResolvedValue({
      id: conversationId,
      shortId: "abc234",
      title: "Routine",
      titleSource: "user",
      description: "",
      descriptionSource: "user",
      keywords: [],
      pinnedAt: null,
      done: null,
      isDone: false,
      lastUsedAt: at,
      archivedAt: null,
      runStatus: "idle",
      runError: null,
      unreadCompletion: false,
      projectId: null,
      draft: { content: [], revision: 1, updatedAt: null },
      createdByUserId: identity.user.id,
      createdAt: at,
      updatedAt: at,
    });
    const catalog = spyOn(capabilityClient, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { appId: "demo", appName: "Demo", appDescription: "", appIcon: "ti ti-app-window", manifest },
    });
    const order: string[] = [];
    const denied = new Error("Mandate denied");
    const authorize = spyOn(aiChatTasks, "authorizeCapability").mockImplementation(async () => {
      order.push("mandate");
      if (outcome === "mandate denied") throw denied;
    });
    const marker = spyOn(aiChatTasks, "markNeedsApproval").mockResolvedValue();
    const review = spyOn(capabilityClient, "reviewCapabilityAction").mockImplementation(async () => {
      order.push("review");
      if (outcome === "review throws") throw new Error("Review unavailable");
      if (outcome === "review unavailable") return { ok: false, error: { code: "NOT_FOUND", status: 404, message: "Review missing" } };
      return { ok: true, data: { message: "Aufgabe zuweisen?" } };
    });
    const invoke = spyOn(capabilityClient, "invokeCapability").mockResolvedValue({ ok: true, data: { data: {} } });
    try {
      const call = runtimeCapabilities.prepare(
        { id: crypto.randomUUID(), name: "demo.write", input: {}, conversationId },
        identity,
        { locale: "de", signal: new AbortController().signal },
        { turnId, mandate },
      );
      if (outcome === "mandate denied") {
        await expect(call).rejects.toBe(denied);
        expect(marker).not.toHaveBeenCalled();
      } else {
        await expect(call).rejects.toMatchObject(new AiBackgroundApprovalRequiredError("Aufgabe zuweisen"));
        expect(marker).toHaveBeenCalledWith({ turnId, action: "Aufgabe zuweisen" });
      }
      expect(invoke).not.toHaveBeenCalled();
      expect(authorize).toHaveBeenCalledWith({
        mandate,
        appId: "demo",
        capabilityId: "write",
        kind: "action",
        input: {},
        approval: "rememberable",
      });
      if (outcome === "mandate denied" || outcome === "no review") {
        expect(review).not.toHaveBeenCalled();
        expect(order).toEqual(["mandate"]);
      } else expect(order).toEqual(["mandate", "review"]);
      // No SQL dependency is installed: reaching the pending-call INSERT would fail this test.
    } finally {
      conversation.mockRestore();
      catalog.mockRestore();
      authorize.mockRestore();
      marker.mockRestore();
      review.mockRestore();
      invoke.mockRestore();
    }
  });
}
