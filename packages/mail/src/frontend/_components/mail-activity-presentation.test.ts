import { describe, expect, test } from "bun:test";
import type { MailActivityEvent } from "../../service/collaboration";
import { mailActivityIcon, mailActivityLabel, presentMailActivity, showMailActivityInline } from "./mail-activity-presentation";

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
});

describe("mail activity presentation", () => {
  test("describes collaboration changes from audit metadata", () => {
    expect(mailActivityLabel(event({ before: { workStatus: "needs_action" }, after: { workStatus: "waiting" } }))).toBe(
      "marked it Waiting for reply",
    );
  });

  test("describes assignee changes, also from activity recorded with a single assignee", () => {
    expect(mailActivityLabel(event({ before: { assigneeUserIds: [] }, after: { assigneeUserIds: ["a", "b"] } }))).toBe(
      "assigned the conversation",
    );
    expect(mailActivityLabel(event({ before: { assigneeUserIds: ["a", "b"] }, after: { assigneeUserIds: ["a"] } }))).toBe(
      "removed an assignee",
    );
    expect(mailActivityLabel(event({ before: { assigneeUserIds: ["a"] }, after: { assigneeUserIds: [] } }), "de")).toBe(
      "hat alle Zuweisungen entfernt",
    );
    expect(mailActivityLabel(event({ before: { assigneeUserId: null }, after: { assigneeUserId: "a" } }))).toBe(
      "assigned the conversation",
    );
    expect(mailActivityLabel(event({ before: { assigneeUserIds: ["a"] }, after: { assigneeUserIds: ["a"] } }))).toBe(
      "updated the conversation",
    );
  });

  test("localizes stable activity actions for regional German locales", () => {
    const tagged = event();
    tagged.action = "conversation.local_tag_added";
    expect(mailActivityLabel(tagged, "de-CH")).toBe("hat einen Tag hinzugefügt");
    expect(mailActivityLabel(event({ before: { workStatus: "needs_action" }, after: { workStatus: "waiting" } }), "de-CH")).toBe(
      "hat den Status auf „Wartet auf Antwort“ gesetzt",
    );
  });

  test("collapses consecutive duplicate events", () => {
    expect(presentMailActivity([event(), event()])).toHaveLength(1);
    expect(presentMailActivity([event(), event()])[0]?.count).toBe(2);
  });

  test("uses quiet semantic icons and names workflows explicitly", () => {
    const workflowEvent = event();
    workflowEvent.actor = { kind: "workflow", id: "Workflow01", displayName: "Invoice triage", avatarHash: null };
    workflowEvent.action = "conversation.local_tag_added";

    expect(mailActivityIcon(workflowEvent)).toBe("ti-tag");
    expect(presentMailActivity([workflowEvent])[0]?.actorLabel).toBe("Workflow Invoice triage");
    expect(showMailActivityInline(workflowEvent)).toBe(true);
  });

  test("shows who started and stopped keeping a conversation in the timeline", () => {
    const kept = { ...event(), action: "conversation.kept" };
    const released = { ...event(), action: "conversation.keep_released" };
    expect(showMailActivityInline(kept)).toBe(true);
    expect(showMailActivityInline(released)).toBe(true);
    expect(mailActivityIcon(kept)).toBe("ti-lock");
    expect(mailActivityIcon(released)).toBe("ti-lock-open");
    expect(mailActivityLabel(kept)).toBe("started keeping the conversation");
    expect(mailActivityLabel(released, "de")).toBe("hat die Aufbewahrung aufgehoben");
    const carried = { ...kept, metadata: { carriedFrom: "conversation-1" } };
    expect(mailActivityLabel(carried)).toBe("moved kept messages here, so this conversation is kept too");
    expect(mailActivityLabel(carried, "de")).toBe(
      "hat aufbewahrte Nachrichten hierher verschoben, daher wird auch diese Unterhaltung aufbewahrt",
    );
    expect(mailActivityIcon(carried)).toBe("ti-lock");
  });

  test("keeps technical activity and human draft churn out of the inline timeline", () => {
    expect(showMailActivityInline(event())).toBe(true);
    expect(showMailActivityInline({ ...event(), action: "command.execute" })).toBe(false);
    expect(showMailActivityInline({ ...event(), action: "draft.created" })).toBe(false);
  });
});
