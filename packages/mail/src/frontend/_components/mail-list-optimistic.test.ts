import { describe, expect, test } from "bun:test";
import type { MailListItem } from "../../service/workspace";
import { mailListMessagePendingKey, reconcileMailListOptimisticState } from "./mail-list-optimistic";

const item = (unread: boolean, flagged: boolean, overrides: Partial<MailListItem> = {}): MailListItem => ({
  id: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000001",
  selectionKind: "conversation",
  primaryReference: null,
  subject: "Subject",
  participantSummary: "Sender",
  participantLabels: ["Sender"],
  latestMessageAt: "2026-07-22T00:00:00.000Z",
  preview: null,
  attachmentMatch: null,
  unread,
  activeFolderIds: [],
  flagged,
  hasAttachments: false,
  messageCount: 1,
  workStatus: "needs_action",
  assigneeUserIds: [],
  snoozedUntil: null,
  sourceFolderId: null,
  unreadFolderIds: [],
  localTags: [],
  revision: 1,
  ...overrides,
});

describe("Mail list optimistic state", () => {
  test("keeps queued flags over stale snapshots and clears them after confirmation", () => {
    const id = item(false, false).conversationId!;
    const stale = reconcileMailListOptimisticState([item(false, false)], new Map([[id, { flagged: true, expiresAt: 2_000 }]]), 1_000);
    expect(stale.items[0]?.flagged).toBe(true);
    expect(stale.pending.has(id)).toBe(true);

    const confirmed = reconcileMailListOptimisticState([item(false, true)], stale.pending, 1_500);
    expect(confirmed.items[0]?.flagged).toBe(true);
    expect(confirmed.pending.has(id)).toBe(false);
  });

  test("reconciles fields independently and drops expired state", () => {
    const id = item(true, false).conversationId!;
    const pending = new Map([[id, { unread: false, flagged: true, expiresAt: 2_000 }]]);
    const partial = reconcileMailListOptimisticState([item(false, false)], pending, 1_000);
    expect(partial.items[0]).toMatchObject({ unread: false, flagged: true });
    expect(partial.pending.get(id)).toEqual({ flagged: true, expiresAt: 2_000 });

    const expired = reconcileMailListOptimisticState([item(true, false)], partial.pending, 2_001);
    expect(expired.items[0]).toMatchObject({ unread: true, flagged: false });
    expect(expired.pending.size).toBe(0);
  });

  test("keeps collaboration fields over stale live snapshots until the canonical revision arrives", () => {
    const id = item(false, false).conversationId!;
    const pending = new Map([
      [
        id,
        {
          workStatus: "waiting" as const,
          assigneeUserIds: ["00000000-0000-4000-8000-000000000002"],
          snoozedUntil: "2026-07-23T08:00:00.000Z",
          revision: 2,
          expiresAt: 2_000,
        },
      ],
    ]);

    const stale = reconcileMailListOptimisticState([item(false, false)], pending, 1_000);
    expect(stale.items[0]).toMatchObject({
      workStatus: "waiting",
      assigneeUserIds: ["00000000-0000-4000-8000-000000000002"],
      snoozedUntil: "2026-07-23T08:00:00.000Z",
      revision: 2,
    });
    expect(stale.pending.has(id)).toBe(true);

    const confirmed = reconcileMailListOptimisticState(
      [
        item(false, false, {
          workStatus: "waiting",
          assigneeUserIds: ["00000000-0000-4000-8000-000000000002"],
          snoozedUntil: "2026-07-23T08:00:00.000Z",
          revision: 3,
        }),
      ],
      stale.pending,
      1_500,
    );
    expect(confirmed.pending.size).toBe(0);
    expect(confirmed.items[0]?.revision).toBe(3);
  });

  test("reconciles tag assignments by id while preserving canonical tag metadata", () => {
    const id = item(false, false).conversationId!;
    const optimisticTag = {
      id: "00000000-0000-4000-8000-000000000003",
      mailboxId: "00000000-0000-4000-8000-000000000004",
      name: "Customer",
      color: "#f97316",
      revision: 1,
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    };
    const canonicalTag = { ...optimisticTag, name: "Customers" };
    const result = reconcileMailListOptimisticState(
      [item(false, false, { localTags: [canonicalTag], revision: 2 })],
      new Map([[id, { localTags: [optimisticTag], revision: 2, expiresAt: 2_000 }]]),
      1_000,
    );

    expect(result.pending.size).toBe(0);
    expect(result.items[0]?.localTags).toEqual([canonicalTag]);
  });

  test("keeps a message row's change on that row, not on the other messages of its conversation", () => {
    const conversationId = "00000000-0000-4000-8000-0000000000c1";
    const row = (id: string) => item(true, false, { id, conversationId, selectionKind: "message" });
    const pending = new Map([[mailListMessagePendingKey("message-a"), { unread: false, expiresAt: 2_000 }]]);
    const reconciled = reconcileMailListOptimisticState([row("message-a"), row("message-b")], pending, 1_000);
    expect(reconciled.items.map((entry) => entry.unread)).toEqual([false, true]);
  });
});
