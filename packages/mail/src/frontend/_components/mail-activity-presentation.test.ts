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

  test("keeps technical activity and human draft churn out of the inline timeline", () => {
    expect(showMailActivityInline(event())).toBe(true);
    expect(showMailActivityInline({ ...event(), action: "command.execute" })).toBe(false);
    expect(showMailActivityInline({ ...event(), action: "draft.created" })).toBe(false);
  });
});
