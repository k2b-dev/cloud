import type { ConversationAssignmentResult } from "../../service/collaboration";
import type { mailWorkspaceMessages } from "../mail-workspace-messages";
import type { MailAssigneeChoice } from "./mail-assign-picker";

type MailWorkspaceText = ReturnType<typeof mailWorkspaceMessages.resolve>["t"];
type AssignmentMode = "add" | "remove" | "replace";

export type MailBulkAssignmentHost = {
  chooseAssignee: () => Promise<MailAssigneeChoice | null>;
  assign: (conversationIds: string[], assigneeUserIds: string[], mode: AssignmentMode) => Promise<ConversationAssignmentResult>;
  /** The assignees a listed conversation has now, or null when the list does not show it. */
  assigneesOf: (conversationId: string) => readonly string[] | null;
  clearSelection: () => void;
  /** Reloads the canonical list; resolves with the refresh error instead of throwing. */
  refresh: () => Promise<Error | null>;
  success: (message: string, undo?: { label: string; run: () => void }) => void;
  error: (message: string, title?: string) => void;
  /** The assignment was saved but the list could not be reloaded. */
  refreshFailed: (error: Error, title: string) => void;
  /** False once the workspace was disposed or the mutation aborted. */
  active: () => boolean;
};

/** Undo reverses the change on the conversations it changed; removing everyone has no undo. */
const undoAssignment = async (
  conversationIds: string[],
  change: { userId: string; mode: "add" | "remove" },
  host: MailBulkAssignmentHost,
  t: MailWorkspaceText,
): Promise<void> => {
  try {
    await host.assign(conversationIds, [change.userId], change.mode);
    if (!host.active()) return;
    const refreshError = await host.refresh();
    if (!host.active()) return;
    host.success(t.assignmentUndone({ count: conversationIds.length }));
    if (refreshError) host.refreshFailed(refreshError, t.assignRefreshFailed);
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
  // Only conversations the change actually touches get undone, so earlier assignments survive an undo.
  const changes = (conversationId: string): boolean => {
    if (choice.userId === null) return true;
    const before = host.assigneesOf(conversationId);
    if (!before) return true;
    return choice.mode === "add" ? !before.includes(choice.userId) : before.includes(choice.userId);
  };
  const touched = conversationIds.filter(changes);
  const result = await host.assign(conversationIds, choice.userId ? [choice.userId] : [], choice.mode);
  if (!host.active()) return;
  const found = new Set(result.results.filter((item) => item.status === "ok").map((item) => item.conversationId));
  const changedIds = touched.filter((id) => found.has(id));
  host.clearSelection();
  const refreshError = await host.refresh();
  if (!host.active()) return;
  if (found.size > 0 && choice.userId !== null) {
    const count = found.size;
    const message =
      choice.mode === "add"
        ? choice.name === null
          ? t.assignedToYou({ count })
          : t.assignedTo({ count, name: choice.name })
        : choice.name === null
          ? t.removedYou({ count })
          : t.removedFrom({ count, name: choice.name });
    const reverse = choice.mode === "add" ? "remove" : "add";
    const userId = choice.userId;
    host.success(
      message,
      changedIds.length > 0 ? { label: t.undo, run: () => void undoAssignment(changedIds, { userId, mode: reverse }, host, t) } : undefined,
    );
  } else if (found.size > 0) {
    host.success(t.unassignedCount({ count: found.size }));
  }
  const missing = result.results.length - found.size;
  if (missing > 0) host.error(t.notAssignedBody, t.notAssignedTitle({ failed: missing, total: result.results.length }));
  if (refreshError) host.refreshFailed(refreshError, t.assignRefreshFailed);
};
