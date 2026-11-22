import { describe, expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import type { MessageSearchHit } from "./search";
import { loadDropAssigneesOrNull, searchHitToListItem } from "./workspace";

const messageId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

const hit: MessageSearchHit = {
  kept: false,
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
  attachmentCount: 0,
  snippet: "Planning",
  attachmentMatch: null,
  unread: true,
  messageCount: 2,
  workStatus: null,
  assigneeUserIds: [],
  snoozedUntil: null,
  revision: 1,
  updatedAt: "2026-08-15T10:00:00.000Z",
  sourceFolderId: null,
  folderPath: null,
  unreadFolderIds: [],
  rank: 0,
};

describe("Mail workspace search results", () => {
  test("a row carries its attachment count only when it has attachments", () => {
    expect(searchHitToListItem(hit, "conversations")).not.toHaveProperty("attachmentCount");
    expect(searchHitToListItem(hit, "conversations")).not.toHaveProperty("hasAttachments");
    expect(searchHitToListItem({ ...hit, hasAttachments: true, attachmentCount: 3 }, "conversations").attachmentCount).toBe(3);
  });

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

describe("Mail workspace drag people", () => {
  const people = { people: [{ id: "u1", uid: "ada", displayName: "Ada", avatarHash: null }], more: false };

  test("a lookup that answers gives its people", async () => {
    expect(await loadDropAssigneesOrNull(async () => ok(people), "box")).toEqual(people);
  });

  test("a refused or throwing lookup leaves the page working without them", async () => {
    expect(await loadDropAssigneesOrNull(async () => fail(err.forbidden("Access denied")), "box")).toBeNull();
    expect(
      await loadDropAssigneesOrNull(async () => {
        throw new Error("connection reset");
      }, "box"),
    ).toBeNull();
  });
});
