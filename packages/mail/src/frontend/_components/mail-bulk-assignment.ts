import type { ConversationAssignmentResult } from "../../service/collaboration";
import type { mailWorkspaceMessages } from "../mail-workspace-messages";
import type { MailAssigneeChoice } from "./mail-assign-picker";

type MailWorkspaceText = ReturnType<typeof mailWorkspaceMessages.resolve>["t"];

export type MailBulkAssignmentHost = {
  chooseAssignee: () => Promise<MailAssigneeChoice | null>;
  assign: (conversationIds: string[], assigneeUserId: string | null) => Promise<ConversationAssignmentResult>;
  clearSelection: () => void;
  /** Reloads the canonical list; resolves with the refresh error instead of throwing. */
  refresh: () => Promise<Error | null>;
  success: (message: string, undo?: { label: string; run: () => void }) => void;
  error: (message: string, title?: string) => void;
  /** False once the workspace was disposed or the mutation aborted. */
  active: () => boolean;
};

/** Undo clears the assignee of the conversations that changed; it does not restore earlier assignees. */
const undoAssignment = async (conversationIds: string[], host: MailBulkAssignmentHost, t: MailWorkspaceText): Promise<void> => {
  try {
    await host.assign(conversationIds, null);
    if (!host.active()) return;
    const refreshError = await host.refresh();
    if (!host.active()) return;
    host.success(t.assignmentUndone({ count: conversationIds.length }));
    if (refreshError) host.error(refreshError.message, t.assignRefreshFailed);
  } catch (error) {
    if (host.active()) host.error(error instanceof Error ? error.message : t.assignFailed);
  }
};

export const runMailBulkAssignment = async (
  conversationIds: string[],
  host: MailBulkAssignmentHost,
  t: MailWorkspaceText,
): Promise<void> => {
  const choice = await host.chooseAssignee();
  if (!choice || !host.active()) return;
  const result = await host.assign(conversationIds, choice.assigneeUserId);
  if (!host.active()) return;
  const changedIds = result.results.filter((item) => item.status === "ok").map((item) => item.conversationId);
  host.clearSelection();
  const refreshError = await host.refresh();
  if (!host.active()) return;
  if (changedIds.length > 0 && result.assignee) {
    host.success(t.assignedTo({ count: changedIds.length, name: result.assignee.displayName }), {
      label: t.undo,
      run: () => void undoAssignment(changedIds, host, t),
    });
  } else if (changedIds.length > 0) {
    host.success(t.unassignedCount({ count: changedIds.length }));
  }
  const missing = result.results.length - changedIds.length;
  if (missing > 0) host.error(t.notAssignedBody, t.notAssignedTitle({ failed: missing, total: result.results.length }));
  if (refreshError) host.error(refreshError.message, t.assignRefreshFailed);
};
