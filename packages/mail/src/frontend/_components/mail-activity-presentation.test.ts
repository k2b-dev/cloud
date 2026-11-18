import { describe, expect, test } from "bun:test";
import type { MailActivityEvent } from "../../service/collaboration";
import { mailActivityActorLabel, mailActivityEntry, mailActivityIcon, mailActivityLabel } from "./mail-activity-presentation";

const event = (metadata: Record<string, unknown> = {}): MailActivityEvent => ({
  id: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
  actor: { kind: "user", id: "user-1", displayName: "Ada", avatarHash: null },
  action: "conversation.collaboration_updated",
  outcome: "confirmed",
  targetType: "conversation",
  targetId: crypto.randomUUID(),
  metadata,
  createdAt: "2026-07-22T10:00:00.000Z",
  conversationSubject: null,
  assignees: null,
});

describe("mail activity presentation", () => {
  test("describes collaboration changes from audit metadata", () => {
    expect(mailActivityLabel(event({ before: { workStatus: "needs_action" }, after: { workStatus: "waiting" } }))).toBe(
      "Marked Waiting for reply",
    );
  });

  test("describes assignee changes, also from activity recorded with a single assignee", () => {
    expect(mailActivityLabel(event({ before: { assigneeUserIds: [] }, after: { assigneeUserIds: ["a", "b"] } }))).toBe(
      "Conversation assigned",
    );
    expect(mailActivityLabel(event({ before: { assigneeUserIds: ["a", "b"] }, after: { assigneeUserIds: ["a"] } }))).toBe(
      "An assignee removed",
    );
    expect(mailActivityLabel(event({ before: { assigneeUserIds: ["a"] }, after: { assigneeUserIds: [] } }), "de")).toBe(
      "Alle Zuweisungen entfernt",
    );
    expect(mailActivityLabel(event({ before: { assigneeUserId: null }, after: { assigneeUserId: "a" } }))).toBe("Conversation assigned");
    expect(mailActivityLabel(event({ before: { assigneeUserIds: ["a"] }, after: { assigneeUserIds: ["a"] } }))).toBe(
      "Conversation updated",
    );
    // Several changes read as one sentence.
    expect(
      mailActivityLabel(
        event({ before: { assigneeUserIds: [], workStatus: "needs_action" }, after: { assigneeUserIds: ["a"], workStatus: "done" } }),
        "de",
      ),
    ).toBe("Unterhaltung zugewiesen und als „Erledigt“ markiert");
  });

  test("localizes stable activity actions for regional German locales", () => {
    const tagged = event();
    tagged.action = "conversation.local_tag_added";
    expect(mailActivityLabel(tagged, "de-CH")).toBe("Tag hinzugefügt");
    expect(mailActivityLabel(event({ before: { workStatus: "needs_action" }, after: { workStatus: "waiting" } }), "de-CH")).toBe(
      "Als „Wartet auf Antwort“ markiert",
    );
  });

  test("an event is one timeline entry that bundles with its repeats by the same person", () => {
    const entry = mailActivityEntry(event({ before: { workStatus: "needs_action" }, after: { workStatus: "done" } }), "de");
    expect(entry).toMatchObject({ at: "2026-07-22T10:00:00.000Z", icon: "ti ti-circle-check", tone: "neutral", actor: "Ada" });
    expect(entry.text).toBe("Als „Erledigt“ markiert");
    expect(entry.bundle?.text(3, [])).toBe("Als „Erledigt“ markiert (3-mal)");
    expect(mailActivityEntry(event(), "en").bundle?.key).toBe(mailActivityEntry(event(), "en").bundle?.key);
    expect(mailActivityEntry({ ...event(), outcome: "failed" }).icon).toBe("ti ti-alert-circle");
    expect(mailActivityEntry({ ...event(), outcome: "failed" }).tone).toBe("danger");
    // The red icon names the failure for screen readers; a done event needs no label.
    expect(mailActivityEntry({ ...event(), outcome: "failed" }, "de").iconLabel).toBe("fehlgeschlagen");
    expect(mailActivityEntry(event(), "de").iconLabel).toBeUndefined();
  });

  test("an action without a text of its own still starts its sentence with a capital", () => {
    expect(mailActivityLabel({ ...event(), action: "conversation.future_thing_done" })).toBe("Future thing done");
  });

  test("uses quiet semantic icons and names workflows explicitly", () => {
    const workflowEvent = event();
    workflowEvent.actor = { kind: "workflow", id: "Workflow01", displayName: "Invoice triage", avatarHash: null };
    workflowEvent.action = "conversation.local_tag_added";

    expect(mailActivityIcon(workflowEvent)).toBe("ti-tag");
    expect(mailActivityActorLabel(workflowEvent)).toBe("Workflow Invoice triage");
    expect(mailActivityEntry(workflowEvent).avatar).toMatchObject({ kind: "service", name: "Invoice triage" });
  });

  test("keeps profile pictures and distinguishes service and system identities", () => {
    const person = { ...event(), actor: { kind: "user" as const, id: "user-1", displayName: "Ada", avatarHash: "fixture-picture" } };
    expect(mailActivityEntry(person).avatar).toEqual({
      name: "Ada",
      kind: "person",
      src: "/api/accounts/users/user-1/avatar?rev=fixture-picture",
    });
    const service = { ...event(), actor: { kind: "service_account" as const, id: "service-1", displayName: "Import", avatarHash: null } };
    expect(mailActivityEntry(service).avatar?.kind).toBe("service");
    const system = { ...event(), actor: { kind: "system" as const, id: null, displayName: "Mail", avatarHash: null } };
    expect(mailActivityEntry(system).avatar?.kind).toBe("system");
    expect(mailActivityEntry({ ...person, actor: { ...person.actor, id: null, avatarHash: null } }).avatar?.kind).toBe("system");
  });

  test("names who started and stopped keeping a conversation", () => {
    const kept = { ...event(), action: "conversation.kept" };
    const released = { ...event(), action: "conversation.keep_released" };
    expect(mailActivityIcon(kept)).toBe("ti-lock");
    expect(mailActivityIcon(released)).toBe("ti-lock-open");
    expect(mailActivityLabel(kept)).toBe("Keeping started");
    expect(mailActivityLabel(released, "de")).toBe("Aufbewahrung aufgehoben");
    const carried = { ...kept, metadata: { carriedFrom: "conversation-1" } };
    expect(mailActivityLabel(carried)).toBe("Kept messages moved here, so this conversation is kept too");
    expect(mailActivityLabel(carried, "de")).toBe(
      "Aufbewahrte Nachrichten hierher verschoben, daher wird auch diese Unterhaltung aufbewahrt",
    );
    expect(mailActivityIcon(carried)).toBe("ti-lock");
  });
});

test("F6 removals appear in the activity with localized consolidation text", () => {
  const removed: MailActivityEvent = {
    ...event({ reason: "reply_draft_consolidation", count: 1 }),
    action: "draft.discarded",
    actor: { kind: "system", id: null, displayName: "Mail", avatarHash: null },
  };
  expect(mailActivityLabel(removed)).toBe("Reply draft removed during consolidation");
  expect(mailActivityLabel(removed, "de")).toContain("Antwortentwurf");
  expect(mailActivityEntry(removed).actor).toBe("Mail");
});
