import { describe, expect, test } from "bun:test";
import type { MailActivityEvent } from "../../service/collaboration";
import { mergeMailEventPages, presentMailEvents } from "./mail-events-presentation";

const ME = "11111111-1111-4111-8111-111111111111";
const MIRA = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-11-03T12:00:00.000Z");

const event = (overrides: Partial<MailActivityEvent> & { id: string }): MailActivityEvent => ({
  conversationId: "Conv01",
  actor: { kind: "user", id: MIRA, displayName: "Mira Schulz", avatarHash: null },
  action: "conversation.comment_created",
  outcome: "confirmed",
  targetType: "comment",
  targetId: "Comm01",
  metadata: {},
  createdAt: "2026-11-03T09:00:00.000Z",
  conversationSubject: "Invoice 4711",
  assignees: null,
  ...overrides,
});

const present = (events: MailActivityEvent[], locale = "de") =>
  presentMailEvents(events, {
    locale,
    currentUserId: ME,
    dateConfig: { timeZone: "Europe/Berlin", locale },
    now,
    tagName: (id) => (id === "Tag001" ? "Rechnung" : undefined),
  });

const sentence = (row: { actorLabel: string; before: string; subject: string | null; after: string }) =>
  `${row.actorLabel} ${row.before}${row.subject ?? ""}${row.after}`;

describe("mailbox event presentation", () => {
  test("names assignments, completions, drafts, comments, sends and automations in German", () => {
    const rows = present([
      event({
        id: "9",
        action: "conversation.collaboration_updated",
        actor: { kind: "user", id: MIRA, displayName: "Mira Schulz", avatarHash: null },
        metadata: { before: { assigneeUserIds: [] }, after: { assigneeUserIds: [MIRA, ME] } },
        assignees: {
          before: [],
          after: [
            { id: MIRA, displayName: "Mira Schulz", avatarHash: null },
            { id: ME, displayName: "Lea Brandt", avatarHash: null },
          ],
        },
      }),
      event({
        id: "8",
        action: "conversation.collaboration_updated",
        metadata: { before: { workStatus: "needs_action" }, after: { workStatus: "done" } },
      }),
      event({ id: "7", action: "draft.created", conversationId: null, conversationSubject: null }),
      event({ id: "6", action: "message.sent", metadata: { result: "failed", intent: "reply", code: "ETLS" } }),
      event({ id: "5", action: "message.sent", metadata: { result: "sent", intent: "reply" }, conversationId: "Conv02" }),
      event({
        id: "4",
        action: "conversation.local_tags_added",
        actor: { kind: "workflow", id: null, displayName: "Rechnungen", avatarHash: null },
        metadata: { addedTagIds: ["Tag001"] },
      }),
      event({
        id: "3",
        action: "conversation.work_state_changed",
        actor: { kind: "system", id: null, displayName: "System", avatarHash: null },
        metadata: { messageId: "Mess01", before: { workStatus: "done" }, after: { workStatus: "needs_action" } },
        createdAt: "2026-11-02T08:00:00.000Z",
      }),
    ]);
    expect(rows.map(sentence)).toEqual([
      "Mira Schulz hat dich zu Invoice 4711 als zuständig hinzugefügt",
      "Mira Schulz hat Invoice 4711 als erledigt markiert",
      "Mira Schulz hat einen Entwurf begonnen",
      "Mira Schulz – eine Nachricht wurde nicht gesendet in Invoice 4711",
      "Mira Schulz hat eine Antwort gesendet in Invoice 4711",
      "Workflow · Rechnungen hat Invoice 4711 mit Tag Rechnung versehen",
      "Mail hat Invoice 4711 wieder geöffnet",
    ]);
    expect(rows[0]?.detail).toBe("Zuständig: Mira Schulz und Du");
    expect(rows.map((row) => row.tone)).toEqual(["assign", "done", "draft", "error", "sent", "automation", "done"]);
    // The failure names its reason and points to the conversation without asking to send again.
    expect(rows[3]?.detail).toBe("Die Nachricht wurde nicht zugestellt. Details in der Unterhaltung.");
    expect(rows[2]?.subject).toBeNull();
    expect(rows[5]?.automated).toBe(true);
    expect(rows.map((row) => row.day)).toEqual(["Heute", "Heute", "Heute", "Heute", "Heute", "Heute", "Gestern"]);
    expect(rows[6]?.detail).toBe("Eine neue Nachricht ist eingegangen.");
  });

  test("names why a send failed as the reader does", () => {
    const [row] = present([
      event({ id: "1", action: "message.sent", metadata: { result: "failed", code: "SMTP_NO_RECIPIENTS_ACCEPTED" } }),
    ]);
    expect(row?.detail).toBe("Der empfangende Server hat die Empfänger abgelehnt. Details in der Unterhaltung.");
  });

  test("merges equal events of one person only within one conversation", () => {
    const rows = present(
      [
        event({ id: "6" }),
        event({ id: "5" }),
        event({ id: "4", conversationId: "Conv02", conversationSubject: "Return label" }),
        event({ id: "3", conversationId: "Conv03", conversationSubject: "Contract" }),
        event({ id: "2", conversationId: null, conversationSubject: null, action: "draft.created" }),
        event({ id: "1", conversationId: null, conversationSubject: null, action: "draft.created" }),
      ],
      "en",
    );
    expect(rows.map((row) => [row.event.id, row.count])).toEqual([
      ["6", 2],
      ["4", 1],
      ["3", 1],
      ["2", 1],
      ["1", 1],
    ]);
  });

  test("keeps loaded older pages when the first page reaches into them, and starts over otherwise", () => {
    const page = (ids: number[], nextCursor: string | null) => ({
      items: ids.map((id) => event({ id: String(id) })),
      nextCursor,
    });
    const shown = page([10, 9, 8, 7, 6, 5], "c5");
    // Two new events: the first page still overlaps what is shown, so 6 and 5 and their cursor stay.
    const merged = mergeMailEventPages(shown, page([12, 11, 10, 9], "c9"));
    expect(merged.items.map((item) => item.id)).toEqual(["12", "11", "10", "9", "8", "7", "6", "5"]);
    expect(merged.nextCursor).toBe("c5");
    // A first page entirely above what is shown would leave a gap, so the feed starts over.
    expect(mergeMailEventPages(shown, page([20, 19], "c19"))).toEqual(page([20, 19], "c19"));
    // A complete first page is the whole feed.
    expect(mergeMailEventPages(shown, page([12, 11], null))).toEqual(page([12, 11], null));
    expect(mergeMailEventPages(null, page([3], null))).toEqual(page([3], null));
  });
});
