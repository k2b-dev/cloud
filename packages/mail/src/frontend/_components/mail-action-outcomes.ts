import { MAX_COMMAND_OUTCOME_IDS, type MailCommandOutcome } from "../../contracts";
import type { MailActionId } from "./mail-actions";

/**
 * How long the workspace follows queued commands. A command that was checked and still waits after
 * that has not failed; it waits for the mailbox, which the mailbox health shows.
 */
export const MAIL_ACTION_OUTCOME_TTL_MS = 15 * 60_000;

/** A command's state as the action request or the outcome request returned it. */
export type MailActionCommand = Pick<MailCommandOutcome, "id" | "state"> & { code?: string | null };

/** A command one action request queued, with the folder that request moved or changed messages in. */
export type MailActionQueuedCommand = MailActionCommand & { sourceFolderId: string };

const PENDING_STATES = new Set<MailCommandOutcome["state"]>(["queued", "executing", "ambiguous"]);
const FAILED_STATES = new Set<MailCommandOutcome["state"]>(["failed", "cancelled", "needs_attention"]);

/** Why a command did not complete: its error code, or its state when the state says more. */
const failureCode = (outcome: MailActionCommand): string => (outcome.state === "failed" ? (outcome.code ?? "failed") : outcome.state);

/** A conversation the action did not change, with the folders where it failed, so Try again repeats only those. */
export type MailActionFailure = { conversationId: string; label: string; sourceFolderIds: string[]; code: string };

/** A followed action that ended with at least one conversation the mail server did not change. */
export type MailActionFailureReport = {
  actionId: MailActionId;
  destinationFolderId: string | null;
  conversationCount: number;
  failures: MailActionFailure[];
};

type FollowedConversation = {
  conversationId: string;
  label: string;
  folderByCommand: Map<string, string>;
  pending: Set<string>;
  /** Pending commands no outcome request has answered yet. */
  unchecked: Set<string>;
  failedFolderIds: Set<string>;
  failureCode: string | null;
};

type FollowedAction = {
  actionId: MailActionId;
  destinationFolderId: string | null;
  startedAt: number;
  conversations: FollowedConversation[];
};

const record = (conversation: FollowedConversation, outcome: MailActionCommand): void => {
  if (PENDING_STATES.has(outcome.state)) return;
  conversation.pending.delete(outcome.id);
  conversation.unchecked.delete(outcome.id);
  if (!FAILED_STATES.has(outcome.state)) return;
  const folderId = conversation.folderByCommand.get(outcome.id);
  if (folderId) conversation.failedFolderIds.add(folderId);
  // An unclear outcome outranks a definite failure: the user has to check it, not repeat it.
  if (outcome.state === "needs_attention" || conversation.failureCode === null) conversation.failureCode = failureCode(outcome);
};

const isPending = (action: FollowedAction): boolean => action.conversations.some((conversation) => conversation.pending.size > 0);

/**
 * The failure report of a finished or expired action, or `null` when every change it saw was made.
 * At expiry, a failed conversation with unfinished commands and a conversation with commands no
 * request could check in time both count as unclear, like `needs_attention`.
 */
const failureReport = (action: FollowedAction): MailActionFailureReport | null => {
  const failures = action.conversations.flatMap((conversation): MailActionFailure[] => {
    const unclear = conversation.failureCode ? conversation.pending.size > 0 : conversation.unchecked.size > 0;
    const code = unclear ? "needs_attention" : conversation.failureCode;
    if (!code) return [];
    return [
      {
        conversationId: conversation.conversationId,
        label: conversation.label,
        sourceFolderIds: [...conversation.failedFolderIds],
        code,
      },
    ];
  });
  return failures.length > 0
    ? {
        actionId: action.actionId,
        destinationFolderId: action.destinationFolderId,
        conversationCount: action.conversations.length,
        failures,
      }
    : null;
};

/**
 * Follows the commands a workspace action queued until each one confirms or fails, so the user
 * hears about a change that did not happen after the action said "queued".
 */
export const createMailActionOutcomes = () => {
  const actions = new Set<FollowedAction>();
  let rotation = 0;

  return {
    /**
     * Follows the commands one action queued, per conversation, as the server returned them.
     * Reports right away when they all already finished.
     */
    follow: (params: {
      actionId: MailActionId;
      destinationFolderId: string | null;
      conversations: readonly { conversationId: string; label: string; commands: readonly MailActionQueuedCommand[] }[];
      now?: number;
    }): MailActionFailureReport | null => {
      const action: FollowedAction = {
        actionId: params.actionId,
        destinationFolderId: params.destinationFolderId,
        startedAt: params.now ?? Date.now(),
        conversations: params.conversations.map((conversation) => {
          const ids = conversation.commands.map((command) => command.id);
          const followed: FollowedConversation = {
            conversationId: conversation.conversationId,
            label: conversation.label,
            folderByCommand: new Map(conversation.commands.map((command) => [command.id, command.sourceFolderId])),
            pending: new Set(ids),
            unchecked: new Set(ids),
            failedFolderIds: new Set(),
            failureCode: null,
          };
          for (const command of conversation.commands) record(followed, command);
          return followed;
        }),
      };
      if (!isPending(action)) return failureReport(action);
      actions.add(action);
      return null;
    },

    /**
     * The pending commands to ask about next, at most one request's worth. Successive calls rotate
     * through all of them, so commands that keep waiting cannot hide a later command's failure.
     */
    pendingCommandIds: (limit = MAX_COMMAND_OUTCOME_IDS): string[] => {
      const ids = [...actions].flatMap((action) => action.conversations.flatMap((conversation) => [...conversation.pending]));
      if (ids.length <= limit) return ids;
      const start = rotation % ids.length;
      rotation = start + limit;
      return [...ids.slice(start), ...ids.slice(0, start)].slice(0, limit);
    },

    /**
     * Applies the outcomes the server reported for the `requested` commands; a requested command
     * the server no longer knows counts as finished. Call it with nothing requested when the request
     * failed, so following still ends after the TTL. Returns the reports of actions that finished or
     * expired with a failure or an unclear outcome.
     */
    apply: (requested: readonly string[], outcomes: readonly MailActionCommand[], now = Date.now()): MailActionFailureReport[] => {
      const asked = new Set(requested);
      const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
      const reports: MailActionFailureReport[] = [];
      for (const action of actions) {
        for (const conversation of action.conversations) {
          for (const id of [...conversation.pending]) {
            if (!asked.has(id)) continue;
            conversation.unchecked.delete(id);
            record(conversation, byId.get(id) ?? { id, state: "confirmed", code: null });
          }
        }
        if (isPending(action) && now - action.startedAt < MAIL_ACTION_OUTCOME_TTL_MS) continue;
        actions.delete(action);
        const report = failureReport(action);
        if (report) reports.push(report);
      }
      return reports;
    },

    hasPending: (): boolean => actions.size > 0,
  };
};

export type MailActionOutcomes = ReturnType<typeof createMailActionOutcomes>;
