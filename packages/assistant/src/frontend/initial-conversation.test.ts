import { describe, expect, test } from "bun:test";
import type { AiConversation } from "@k2b/cloud/ai";
import { resolveInitialConversation } from "./initial-conversation";

const conversation = (id: string): AiConversation => ({
  id,
  shortId: id,
  title: id,
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
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("resolveInitialConversation", () => {
  test("uses the newest listed conversation without a deep link", async () => {
    const recent = [conversation("recent"), conversation("older")];
    const result = await resolveInitialConversation({
      conversations: recent,
      loadConversation: async () => {
        throw new Error("lookup should not run");
      },
    });

    expect(result.activeConversation?.id).toBe("recent");
    expect(result.conversations).toBe(recent);
  });

  test("uses a listed deep link without another query", async () => {
    const recent = [conversation("recent"), conversation("requested")];
    const result = await resolveInitialConversation({
      requestedConversationId: "requested",
      conversations: recent,
      loadConversation: async () => {
        throw new Error("lookup should not run");
      },
    });

    expect(result.activeConversation?.id).toBe("requested");
    expect(result.conversations).toBe(recent);
  });

  test("loads and includes a valid deep link outside the recent window", async () => {
    const recent = [conversation("recent")];
    const requested = conversation("requested");
    const result = await resolveInitialConversation({
      requestedConversationId: requested.id,
      conversations: recent,
      loadConversation: async (conversationId) => (conversationId === requested.id ? requested : null),
    });

    expect(result.activeConversation).toBe(requested);
    expect(result.conversations.map((item) => item.id)).toEqual(["requested", "recent"]);
  });

  test("keeps the existing fallback for an unavailable deep link", async () => {
    const recent = [conversation("recent")];
    const result = await resolveInitialConversation({
      requestedConversationId: "missing",
      conversations: recent,
      loadConversation: async () => null,
    });

    expect(result.activeConversation?.id).toBe("recent");
    expect(result.conversations).toBe(recent);
  });
});
