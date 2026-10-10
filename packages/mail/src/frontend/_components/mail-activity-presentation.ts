import type { MailActivityEvent } from "../../service/collaboration";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

type CollaborationSnapshot = {
  assigneeUserIds?: unknown;
  /** Activity recorded before a conversation could have several assignees. */
  assigneeUserId?: unknown;
  workStatus?: unknown;
  snoozedUntil?: unknown;
};

const snapshot = (value: unknown): CollaborationSnapshot => (value && typeof value === "object" ? (value as CollaborationSnapshot) : {});

const assigneesOf = (value: CollaborationSnapshot): string[] => {
  if (Array.isArray(value.assigneeUserIds)) return value.assigneeUserIds.filter((id): id is string => typeof id === "string");
  return typeof value.assigneeUserId === "string" ? [value.assigneeUserId] : [];
};

const collaborationPresentation = (event: MailActivityEvent, locale: string): { label: string; icon: string } => {
  const t = mailConversationUiMessages.resolve([locale]).t;
  const before = snapshot(event.metadata.before);
  const after = snapshot(event.metadata.after);
  const changes: string[] = [];
  let icon = "ti-pencil";
  const assigneesBefore = assigneesOf(before);
  const assigneesAfter = assigneesOf(after);
  const added = assigneesAfter.some((id) => !assigneesBefore.includes(id));
  const removed = assigneesBefore.some((id) => !assigneesAfter.includes(id));
  if (added || removed) {
    changes.push(assigneesAfter.length === 0 ? t.activityUnassigned : added ? t.activityAssigned : t.activityAssigneeRemoved);
    icon = assigneesAfter.length === 0 ? "ti-user-off" : "ti-user-check";
  }
  if (before.workStatus !== after.workStatus) {
    const status = after.workStatus === "done" ? t.done : after.workStatus === "waiting" ? t.waitingForReply : t.needsAction;
    changes.push(t.activityMarked({ status }));
    icon = after.workStatus === "done" ? "ti-circle-check" : after.workStatus === "waiting" ? "ti-hourglass" : "ti-message-reply";
  }
  if (before.snoozedUntil !== after.snoozedUntil) {
    changes.push(after.snoozedUntil ? t.activitySnoozed : t.activityUnsnoozed);
    icon = "ti-alarm-snooze";
  }
  return { label: changes.join(t.activityAnd) || t.activityUpdated, icon };
};

export const mailActivityLabel = (event: MailActivityEvent, locale = "en"): string => {
  const resolved = mailConversationUiMessages.resolve([locale]);
  const t = resolved.t;
  if (event.action === "conversation.collaboration_updated" || event.action === "conversation.work_state_changed")
    return collaborationPresentation(event, locale).label;
  if (event.action === "conversation.kept" && event.metadata.carriedFrom) return t.activityKeptCarried;
  const labels: Readonly<Record<string, string>> = {
    "conversation.comment_created": t.activityCommentCreated,
    "conversation.comment_deleted": t.activityCommentDeleted,
    "conversation.comment_updated": t.activityCommentUpdated,
    "conversation.kept": t.activityKept,
    "conversation.keep_released": t.activityKeepReleased,
    "conversation.local_tag_added": t.activityTagAdded,
    "conversation.local_tag_removed": t.activityTagRemoved,
    "conversation.local_tags_added": t.activityTagsAdded,
    "conversation.local_tags_updated": t.activityTagsUpdated,
    "conversation.merged": t.activityMerged,
    "conversation.message_reassigned": t.activityMessageMoved,
    "conversation.reference_allocated": t.activityReference,
    "conversation.snooze_expired": t.activitySnoozeExpired,
    "conversation.split": t.activitySplit,
    "conversation.summary_updated": t.activitySummary,
    "draft.created": t.activityDraftCreated,
    "draft.derived": t.activityDraftDerived,
    "draft.discarded": t.activityDraftDiscarded,
    "message.delivery_receipt_received": t.activityDeliveryReceipt,
    "message.read_receipt_received": t.activityReadReceipt,
  };
  return labels[event.action] ?? (resolved.locale === "en" ? event.action.split(".").at(-1)!.replaceAll("_", " ") : event.action);
};

const inlineActions = new Set([
  "conversation.collaboration_updated",
  "conversation.kept",
  "conversation.keep_released",
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
    return collaborationPresentation(event, "en").icon;
  if (event.action.includes("local_tag")) return "ti-tag";
  if (event.action === "conversation.kept") return "ti-lock";
  if (event.action === "conversation.keep_released") return "ti-lock-open";
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

export const mailActivityActorLabel = (event: MailActivityEvent, locale = "en"): string => {
  const t = mailConversationUiMessages.resolve([locale]).t;
  return event.actor.kind === "workflow" && event.actor.displayName !== "Workflow"
    ? t.workflowActor({ name: event.actor.displayName })
    : event.actor.displayName;
};

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

export const presentMailActivity = (events: MailActivityEvent[], locale = "en"): PresentedMailActivity[] => {
  const presented: PresentedMailActivity[] = [];
  for (const event of events) {
    const label = mailActivityLabel(event, locale);
    const actorLabel = mailActivityActorLabel(event, locale);
    const previous = presented.at(-1);
    if (previous && previous.actor.id === event.actor.id && previous.actor.kind === event.actor.kind && previous.label === label) {
      previous.count += 1;
      continue;
    }
    presented.push({ ...event, actorLabel, label, icon: mailActivityIcon(event), count: 1 });
  }
  return presented;
};
