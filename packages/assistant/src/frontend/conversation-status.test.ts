import { describe, expect, test } from "bun:test";
import type { AiConversation } from "@k2b/cloud/ai";
import { conversationStatusPresentation } from "./conversation-view";

const conversation = (overrides: Partial<AiConversation> = {}): AiConversation => ({
  id: "chat-1",
  shortId: "cHt234",
  title: "Chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  createdByUserId: "user-1",
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
  ...overrides,
  draft: overrides.draft ?? { content: [], revision: 0, updatedAt: null },
});

describe("Assistant conversation status", () => {
  test("presents every durable run state with clear copy", () => {
    expect(conversationStatusPresentation(conversation({ runStatus: "queued" }))?.label).toBe("Queued");
    expect(conversationStatusPresentation(conversation({ runStatus: "running" }))?.label).toBe("Running");
    expect(conversationStatusPresentation(conversation({ runStatus: "needs_attention" }))?.label).toBe("Needs attention");
    expect(conversationStatusPresentation(conversation({ runStatus: "failed" }))?.label).toBe("Failed");
  });

  test("shows new response only for an otherwise idle conversation", () => {
    expect(conversationStatusPresentation(conversation({ unreadCompletion: true }))?.label).toBe("New response");
    expect(conversationStatusPresentation(conversation())).toBeNull();
  });
});
