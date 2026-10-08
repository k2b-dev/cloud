import { describe, expect, test } from "bun:test";
import type { AiConversation } from "@k2b/cloud/ai";
import { conversationStatusPresentation, groupConversationsByAge } from "./conversation-view";

const conversation = (overrides: Partial<AiConversation> = {}): AiConversation => ({
  id: "chat-1",
  shortId: "cHt234",
  title: "Chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-09-14T00:00:00.000Z",
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
  test("browser work never asks for human attention", () => {
    const waiting = conversation({ runStatus: "waiting_for_browser" });
    expect(conversationStatusPresentation(waiting)?.icon).toBe("ti ti-browser");
    expect(conversationStatusPresentation(waiting, "en", true)?.label).toBe("Running");
    expect(conversationStatusPresentation(waiting, "de")?.label).toBe("Wartet auf Browser-Ausführung");
  });
  test("presents every durable run state with clear copy", () => {
    expect(conversationStatusPresentation(conversation({ runStatus: "queued" }))?.label).toBe("Queued");
    expect(conversationStatusPresentation(conversation({ runStatus: "running" }))?.label).toBe("Running");
    expect(conversationStatusPresentation(conversation({ runStatus: "needs_attention" }))?.label).toBe("Waiting for you");
    expect(conversationStatusPresentation(conversation({ runStatus: "failed" }))?.label).toBe("Failed");
  });

  test("shows new response only for an otherwise idle conversation", () => {
    expect(conversationStatusPresentation(conversation({ unreadCompletion: true }))?.label).toBe("New response");
    expect(conversationStatusPresentation(conversation())).toBeNull();
  });
});

describe("Assistant chat list sections", () => {
  const now = "2026-10-08T00:30:00.000Z";
  const at = (id: string, lastUsedAt: string, pinnedAt: string | null = null) => conversation({ id, lastUsedAt, pinnedAt });
  const sections = (timeZone: string) =>
    groupConversationsByAge(
      [
        at("pinned", "2026-01-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"),
        at("late", "2026-10-07T23:30:00.000Z"),
        at("yesterday", "2026-10-07T12:00:00.000Z"),
        at("week", "2026-10-03T12:00:00.000Z"),
        at("month", "2026-09-20T12:00:00.000Z"),
        at("older", "2026-06-01T12:00:00.000Z"),
      ],
      now,
      timeZone,
    ).map((section) => [section.group, section.conversations.map((item) => item.id)]);

  test("orders pinned chats first, then calendar days in the viewer's time zone", () => {
    expect(sections("Europe/Berlin")).toEqual([
      ["pinned", ["pinned"]],
      ["today", ["late"]],
      ["yesterday", ["yesterday"]],
      ["week", ["week"]],
      ["month", ["month"]],
      ["older", ["older"]],
    ]);
    // 23:30 UTC on the 7th is already the 8th in Berlin, but still yesterday in UTC.
    expect(sections("UTC")[1]).toEqual(["yesterday", ["late", "yesterday"]]);
  });
});
