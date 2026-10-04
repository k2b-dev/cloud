import { describe, expect, test } from "bun:test";
import type { MessageSearchHit } from "./search";
import { searchHitToListItem } from "./workspace";

const messageId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

const hit: MessageSearchHit = {
  id: messageId,
  conversationId,
  primaryReference: null,
  subject: "Release planning",
  participantSummary: "Apache",
  participantLabels: ["Apache"],
  latestMessageAt: "2026-08-15T10:00:00.000Z",
  messageId: "<release@example.test>",
  internalDate: "2026-08-15T10:00:00.000Z",
  sentAt: "2026-08-15T10:00:00.000Z",
  from: [{ name: "Apache", address: "dev@example.test" }],
  to: [],
  flags: [],
  activeFolderIds: [],
  flagged: false,
  hasAttachments: false,
  snippet: "Planning",
  attachmentMatch: null,
  unread: true,
  messageCount: 2,
  workStatus: null,
  assigneeUserId: null,
  snoozedUntil: null,
  revision: 1,
  updatedAt: "2026-08-15T10:00:00.000Z",
  sourceFolderId: null,
  folderPath: null,
  unreadFolderIds: [],
  rank: 0,
};

describe("Mail workspace search results", () => {
  test("uses the conversation ID for grouped conversation rows", () => {
    expect(searchHitToListItem(hit, "conversations")).toMatchObject({
      id: conversationId,
      conversationId,
      selectionKind: "conversation",
    });
  });

  test("keeps the message ID for message rows and unthreaded hits", () => {
    expect(searchHitToListItem(hit, "messages")).toMatchObject({ id: messageId, conversationId, selectionKind: "message" });
    expect(searchHitToListItem({ ...hit, conversationId: null }, "conversations")).toMatchObject({
      id: messageId,
      conversationId: null,
      selectionKind: "message",
    });
  });
});
