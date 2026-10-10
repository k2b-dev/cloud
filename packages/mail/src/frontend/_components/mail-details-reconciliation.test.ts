import { describe, expect, test } from "bun:test";
import type { ConversationCollaboration, ConversationComment } from "../../service/collaboration";
import type { ConversationLocalTags, LocalTag } from "../../service/local-tags";
import type { ConversationReminder } from "../../service/reminders";
import {
  reconcileAvailableTags,
  reconcileCollaboration,
  reconcileComments,
  reconcileConversationSummary,
  reconcileConversationTags,
  reconcileReminder,
} from "./mail-details-reconciliation";

const collaboration = (revision: number, workStatus: ConversationCollaboration["workStatus"]): ConversationCollaboration => ({
  conversationId: "00000000-0000-4000-8000-000000000001",
  assignees: [],
  workStatus,
  snoozedUntil: null,
  revision,
});

const tag = (id: string, name: string, revision = 1): LocalTag => ({
  id,
  mailboxId: "00000000-0000-4000-8000-000000000002",
  name,
  color: "#6b7280",
  revision,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const comment = (id: string, revision: number, body: string): ConversationComment => ({
  id,
  conversationId: "00000000-0000-4000-8000-000000000001",
  body,
  author: { kind: "user", id: "00000000-0000-4000-8000-000000000003", displayName: "Ada", avatarHash: null },
  referencedMessageId: null,
  revision,
  canEdit: true,
  canDelete: true,
  editedAt: null,
  deletedAt: null,
  createdAt: `2026-01-0${id}T00:00:00.000Z`,
  updatedAt: `2026-01-0${id}T00:00:00.000Z`,
});

const reminder = (revision: number, state: ConversationReminder["state"] = "pending"): ConversationReminder => ({
  id: "00000000-0000-4000-8000-000000000020",
  conversationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000003",
  dueAt: "2026-01-10T09:00:00.000Z",
  state,
  revision,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("Mail details reconciliation", () => {
  test("applies a confirmed conversation summary without regressing a newer live revision", () => {
    const saved = { summary: "Saved now", summaryRevision: 2, conversationRevision: 5 };
    const newer = { summary: "Updated elsewhere", summaryRevision: 3, conversationRevision: 6 };

    expect(reconcileConversationSummary(null, saved)).toEqual(saved);
    expect(reconcileConversationSummary(saved, newer)).toEqual(newer);
    expect(reconcileConversationSummary(newer, saved)).toEqual(newer);
  });

  test("applies newer collaboration and tag revisions but rejects stale snapshots", () => {
    expect(reconcileCollaboration(collaboration(3, "done"), collaboration(2, "needs_action")).workStatus).toBe("done");
    expect(reconcileCollaboration(collaboration(2, "needs_action"), collaboration(3, "done")).workStatus).toBe("done");

    const current: ConversationLocalTags = {
      conversationId: "00000000-0000-4000-8000-000000000001",
      conversationRevision: 3,
      tags: [tag("00000000-0000-4000-8000-000000000010", "Local")],
    };
    expect(reconcileConversationTags(current, { ...current, conversationRevision: 2, tags: [] })).toBe(current);
    expect(reconcileConversationTags(current, { ...current, conversationRevision: 4, tags: [] }).tags).toEqual([]);
  });

  test("merges live comments without dropping a locally confirmed comment", () => {
    const local = comment("1", 1, "Local");
    const remote = comment("2", 1, "Remote");
    const edited = comment("1", 2, "Edited remotely");
    expect(reconcileComments([local], [remote])).toEqual([local, remote]);
    expect(reconcileComments([{ ...local, body: null, deletedAt: "2026-01-03T00:00:00.000Z" }], [local])).toEqual([
      { ...local, body: null, deletedAt: "2026-01-03T00:00:00.000Z" },
    ]);
    expect(reconcileComments([local, remote], [edited, remote])).toEqual([edited, remote]);
  });

  test("keeps an unconfirmed local tag while honoring deletion of a confirmed tag", () => {
    const confirmed = tag("00000000-0000-4000-8000-000000000010", "Confirmed");
    const local = tag("00000000-0000-4000-8000-000000000011", "Local");
    const result = reconcileAvailableTags([confirmed, local], [], new Set([confirmed.id]));
    expect(result.tags).toEqual([local]);
    expect(result.confirmedIds).toEqual(new Set());
  });

  test("keeps a locally saved reminder over stale snapshots and applies a newer cancellation", () => {
    expect(reconcileReminder(reminder(2), reminder(1))).toEqual(reminder(2));
    expect(reconcileReminder(reminder(2), null)).toEqual(reminder(2));
    expect(reconcileReminder(reminder(2), reminder(3, "canceled"))).toEqual(reminder(3, "canceled"));
  });
});
