import { describe, expect, test } from "bun:test";
import type { MailActivityEvent } from "../../service/collaboration";
import { buildMailConversationTimeline } from "./mail-conversation-timeline";

const activity = (overrides: Partial<MailActivityEvent> = {}): MailActivityEvent => ({
  id: "10",
  conversationId: "Conv01",
  actor: { kind: "workflow", id: "Workflow01", displayName: "Invoice triage", avatarHash: null },
  action: "conversation.local_tag_added",
  outcome: "confirmed",
  targetType: "local_tag",
  targetId: "Tag001",
  metadata: {},
  createdAt: "2026-08-20T12:02:00.000Z",
  ...overrides,
});

describe("mail conversation timeline", () => {
  test("interleaves quiet domain activity with messages newest first", () => {
    const timeline = buildMailConversationTimeline(
      [
        { id: "Old", internalDate: "2026-08-20T12:00:00.000Z" },
        { id: "New", internalDate: "2026-08-20T12:03:00.000Z" },
      ],
      [activity()],
    );

    expect(timeline.map((item) => item.id)).toEqual(["message:New", "activity:10", "message:Old"]);
    expect(timeline[1]?.kind === "activity" && timeline[1].activity).toMatchObject({
      actorLabel: "Workflow Invoice triage",
      icon: "ti-tag",
      label: "added a tag",
    });
  });

  test("keeps technical events and human draft churn out of the reader", () => {
    const timeline = buildMailConversationTimeline(
      [],
      [
        activity({ id: "1", action: "command.execute" }),
        activity({ id: "2", action: "draft.created", actor: { kind: "user", id: "User01", displayName: "Ada", avatarHash: null } }),
        activity({ id: "3", action: "conversation.work_state_changed" }),
      ],
    );

    expect(timeline).toEqual([]);
  });

  test("groups only adjacent duplicate activity and never across a message", () => {
    const timeline = buildMailConversationTimeline(
      [{ id: "Message", internalDate: "2026-08-20T12:01:30.000Z" }],
      [
        activity({ id: "3", createdAt: "2026-08-20T12:03:00.000Z" }),
        activity({ id: "2", createdAt: "2026-08-20T12:02:00.000Z" }),
        activity({ id: "1", createdAt: "2026-08-20T12:01:00.000Z" }),
      ],
    );

    expect(timeline).toHaveLength(3);
    expect(timeline[0]?.kind === "activity" && timeline[0].activity.count).toBe(2);
    expect(timeline[1]?.kind).toBe("message");
    expect(timeline[2]?.kind === "activity" && timeline[2].activity.count).toBe(1);
  });
});
