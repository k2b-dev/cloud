import type { MailActivityEvent } from "../../service/collaboration";

const labels: Readonly<Record<string, string>> = {
  "conversation.comment_created": "added an internal comment",
  "conversation.comment_deleted": "deleted an internal comment",
  "conversation.comment_updated": "updated an internal comment",
  "conversation.local_tag_added": "added a tag",
  "conversation.local_tag_removed": "removed a tag",
  "conversation.local_tags_added": "added tags",
  "conversation.local_tags_updated": "updated tags",
  "conversation.merged": "merged conversations",
  "conversation.message_reassigned": "moved a message between conversations",
  "conversation.reference_allocated": "assigned a reference number",
  "conversation.snooze_expired": "returned the conversation from snooze",
  "conversation.split": "split the conversation",
  "conversation.summary_updated": "updated the summary",
  "draft.created": "created a draft",
  "draft.derived": "created a draft from this conversation",
  "draft.discarded": "discarded a draft",
  "message.delivery_receipt_received": "received a delivery-status report",
  "message.read_receipt_received": "received a read-receipt report",
};

type CollaborationSnapshot = {
  assigneeUserId?: unknown;
  workStatus?: unknown;
  snoozedUntil?: unknown;
};

const snapshot = (value: unknown): CollaborationSnapshot => (value && typeof value === "object" ? (value as CollaborationSnapshot) : {});

const workStatusLabel = (value: unknown): string =>
  value === "done" ? "Done" : value === "waiting" ? "Waiting for reply" : "Needs action";

const collaborationPresentation = (event: MailActivityEvent): { label: string; icon: string } => {
  const before = snapshot(event.metadata.before);
  const after = snapshot(event.metadata.after);
  const changes: string[] = [];
  let icon = "ti-pencil";
  if (before.assigneeUserId !== after.assigneeUserId) {
    changes.push(after.assigneeUserId ? "assigned the conversation" : "removed the assignee");
    icon = "ti-user-check";
  }
  if (before.workStatus !== after.workStatus) {
    changes.push(`marked it ${workStatusLabel(after.workStatus)}`);
    icon = after.workStatus === "done" ? "ti-circle-check" : after.workStatus === "waiting" ? "ti-hourglass" : "ti-message-reply";
  }
  if (before.snoozedUntil !== after.snoozedUntil) {
    changes.push(after.snoozedUntil ? "snoozed the conversation" : "removed the snooze");
    icon = "ti-alarm-snooze";
  }
  return { label: changes.join(" and ") || "updated the conversation", icon };
};

export const mailActivityLabel = (event: MailActivityEvent): string => {
  if (event.action === "conversation.collaboration_updated" || event.action === "conversation.work_state_changed")
    return collaborationPresentation(event).label;
  return labels[event.action] ?? event.action.split(".").at(-1)!.replaceAll("_", " ");
};

const inlineActions = new Set([
  "conversation.collaboration_updated",
  "conversation.local_tag_added",
  "conversation.local_tag_removed",
  "conversation.local_tags_added",
  "conversation.local_tags_updated",
  "conversation.merged",
  "conversation.message_reassigned",
  "conversation.reference_allocated",
  "conversation.snooze_expired",
  "conversation.split",
  "conversation.summary_updated",
  "draft.created",
  "draft.derived",
  "draft.discarded",
]);

export const mailActivityIcon = (event: MailActivityEvent): string => {
  if (event.action === "conversation.collaboration_updated" || event.action === "conversation.work_state_changed")
    return collaborationPresentation(event).icon;
  if (event.action.includes("local_tag")) return "ti-tag";
  if (event.action === "conversation.summary_updated") return "ti-pencil";
  if (event.action.startsWith("draft.")) return event.action === "draft.discarded" ? "ti-file-x" : "ti-file-pencil";
  if (event.action === "conversation.reference_allocated") return "ti-hash";
  if (event.action === "conversation.merged") return "ti-git-merge";
  if (event.action === "conversation.split" || event.action === "conversation.message_reassigned") return "ti-arrows-split";
  if (event.action === "conversation.snooze_expired") return "ti-alarm";
  if (event.action.startsWith("conversation.comment_")) return "ti-message-circle";
  if (event.action === "message.read_receipt_received") return "ti-eye-check";
  if (event.action === "message.delivery_receipt_received") return "ti-checks";
  return "ti-history";
};

export const mailActivityActorLabel = (event: MailActivityEvent): string =>
  event.actor.kind === "workflow" && event.actor.displayName !== "Workflow"
    ? `Workflow ${event.actor.displayName}`
    : event.actor.displayName;

export const showMailActivityInline = (event: MailActivityEvent): boolean =>
  inlineActions.has(event.action) &&
  (event.outcome === "confirmed" || event.outcome === "failed") &&
  (!event.action.startsWith("draft.") || event.actor.kind === "workflow");

export type PresentedMailActivity = MailActivityEvent & {
  actorLabel: string;
  label: string;
  icon: string;
  count: number;
};

export const presentMailActivity = (events: MailActivityEvent[]): PresentedMailActivity[] => {
  const presented: PresentedMailActivity[] = [];
  for (const event of events) {
    const label = mailActivityLabel(event);
    const actorLabel = mailActivityActorLabel(event);
    const previous = presented.at(-1);
    if (previous && previous.actor.id === event.actor.id && previous.actor.kind === event.actor.kind && previous.label === label) {
      previous.count += 1;
      continue;
    }
    presented.push({ ...event, actorLabel, label, icon: mailActivityIcon(event), count: 1 });
  }
  return presented;
};
