import { describe, expect, test } from "bun:test";
import type { AiChatTask } from "@k2b/cloud/ai";
import { reconcileAiChatTaskSchedules, recoverAiChatTasks } from "./ai-chat-tasks-runtime";

const task = (id: string): AiChatTask => ({
  id,
  shortId: id,
  chatId: "chat",
  chatTitle: "Chat",
  conversationId: "conversation",
  sponsorUserId: "sponsor",
  mandateId: "mandate",
  mandateRevision: 1,
  prompt: "Check",
  schedule: { kind: "cron", cron: "0 9 * * *" },
  timezone: "UTC",
  state: "active",
  revision: 0,
  lastError: null,
  createdAt: "2026-09-02T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
});

describe("scheduled chat recovery isolation", () => {
  test("continues registration and obsolete removal after individual failures", async () => {
    const registered: string[] = [];
    const removed: string[] = [];
    await reconcileAiChatTaskSchedules({
      tasks: [task("bad"), task("good")],
      register: async (entry) => {
        registered.push(entry.id);
        if (entry.id === "bad") throw new Error("registration failure");
      },
      list: async () => [{ id: "task:bad" }, { id: "task:good" }, { id: "task:old-bad" }, { id: "task:old-good" }, { id: "recovery" }],
      remove: async (id) => {
        removed.push(id);
        if (id === "task:old-bad") throw new Error("deletion failure");
      },
      removeObsolete: true,
    });
    expect(registered).toEqual(["bad", "good"]);
    expect(removed).toEqual(["task:old-bad", "task:old-good"]);
  });

  test("does not remove schedules while mandate preparation is incomplete", async () => {
    let listed = false;
    await reconcileAiChatTaskSchedules({
      tasks: [],
      register: async () => undefined,
      list: async () => {
        listed = true;
        return [];
      },
      remove: async () => undefined,
      removeObsolete: false,
    });
    expect(listed).toBe(false);
  });

  test("isolates every recovery phase and each terminal occurrence and submission", async () => {
    const calls: string[] = [];
    const result = await recoverAiChatTasks({
      reconcile: async () => {
        calls.push("reconcile");
        throw new Error("reconcile failure");
      },
      listTerminal: async () => [
        { turnId: "bad", status: "failed" },
        { turnId: "good", status: "completed" },
      ],
      finalize: async ({ turnId }) => {
        calls.push(`finalize:${turnId}`);
        if (turnId === "bad") throw new Error("poison terminal");
      },
      materialize: async () => {
        calls.push("materialize");
        throw new Error("materialization failure");
      },
      listQueued: async () => [{ occurrence: { id: "bad" } }, { occurrence: { id: "good" } }],
      submit: async (id) => {
        calls.push(`submit:${id}`);
        if (id === "bad") throw new Error("submission failure");
      },
      deliverMessages: async () => {
        calls.push("messages");
      },
    });
    expect(result).toEqual({ queued: 1 });
    expect(calls).toEqual(["reconcile", "finalize:bad", "finalize:good", "materialize", "submit:bad", "submit:good", "messages"]);
  });

  test("listing failures do not prevent independent recovery work or message delivery", async () => {
    const calls: string[] = [];
    const result = await recoverAiChatTasks({
      reconcile: async () => undefined,
      listTerminal: async () => {
        throw new Error("terminal listing failure");
      },
      finalize: async () => {
        throw new Error("must not finalize");
      },
      materialize: async () => {
        calls.push("materialize");
      },
      listQueued: async () => {
        throw new Error("queued listing failure");
      },
      submit: async () => {
        throw new Error("must not submit");
      },
      deliverMessages: async () => {
        calls.push("messages");
        throw new Error("delivery failure");
      },
    });
    expect(result).toEqual({ queued: 0 });
    expect(calls).toEqual(["materialize", "messages"]);
  });
});
