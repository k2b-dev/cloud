import { describe, expect, test } from "bun:test";
import type { AiConversation } from "@k2b/cloud/ai";
import { submitAssistantProjectMessage } from "./assistant-project-chat";

const conversation = { id: "chat123", projectId: "project123" } as AiConversation;

describe("submitAssistantProjectMessage", () => {
  test("creates a Project chat, sends the standard message, and only then navigates", async () => {
    const events: string[] = [];
    let activeId: string | null = null;
    const result = await submitAssistantProjectMessage({
      projectId: "project123",
      message: { message: "Hello", files: [new File(["notes"], "notes.txt", { type: "text/plain" })] },
      modelProfileId: "model123",
      activeConversationId: () => activeId,
      openConversation: async () => "failed",
      createConversation: async () => {
        events.push("create");
        activeId = conversation.id;
        return conversation;
      },
      send: async (message) => {
        events.push(`send:${message.message}:${message.modelProfileId}:${message.files?.length}`);
        return true;
      },
      rememberPending: () => events.push("remember"),
      clearPending: () => events.push("clear"),
      navigate: () => events.push("navigate"),
    });

    expect(result).toBe(true);
    expect(events).toEqual(["create", "remember", "send:Hello:model123:1", "clear", "navigate"]);
  });

  test("keeps the pending chat and does not navigate when sending fails", async () => {
    let pendingId: string | null = null;
    let navigated = false;
    const result = await submitAssistantProjectMessage({
      projectId: "project123",
      message: { message: "Retry me", files: [] },
      activeConversationId: () => conversation.id,
      openConversation: async () => "failed",
      createConversation: async () => conversation,
      send: async () => false,
      rememberPending: (pending) => {
        pendingId = pending.id;
      },
      clearPending: () => {
        pendingId = null;
      },
      navigate: () => {
        navigated = true;
      },
    });

    expect(result).toBe(false);
    expect(String(pendingId)).toBe(conversation.id);
    expect(navigated).toBe(false);
  });

  test("reuses a pending Project chat instead of creating another one", async () => {
    let created = false;
    let opened = false;
    const result = await submitAssistantProjectMessage({
      projectId: "project123",
      message: { message: "Try again", files: [] },
      pendingConversation: conversation,
      activeConversationId: () => "other-chat",
      openConversation: async () => {
        opened = true;
        return "opened";
      },
      createConversation: async () => {
        created = true;
        return conversation;
      },
      send: async () => true,
      rememberPending: () => undefined,
      clearPending: () => undefined,
      navigate: () => undefined,
    });

    expect(result).toBe(true);
    expect(opened).toBe(true);
    expect(created).toBe(false);
  });
});
