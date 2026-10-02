import { MAX_COMMAND_OUTCOME_IDS, type MailCommandOutcome } from "../../contracts";
import type { MailActionId } from "./mail-actions";

/**
 * How long the workspace follows queued commands. A command still pending after that has not
 * failed; it waits for the mailbox, which the mailbox health shows.
 */
export const MAIL_ACTION_OUTCOME_TTL_MS = 15 * 60_000;

/** A command's state as the action request or the outcome request returned it. */
export type MailActionCommand = Pick<MailCommandOutcome, "id" | "state"> & { code?: string | null };

const PENDING_STATES = new Set<MailCommandOutcome["state"]>(["queued", "executing", "ambiguous"]);
const FAILED_STATES = new Set<MailCommandOutcome["state"]>(["failed", "cancelled", "needs_attention"]);

/** Why a command did not complete: its error code, or its state when the state says more. */
const failureCode = (outcome: MailActionCommand): string => (outcome.state === "failed" ? (outcome.code ?? "failed") : outcome.state);

export type MailActionFailure = { conversationId: string; label: string; code: string };

/** A followed action that ended with at least one conversation the mail server did not change. */
export type MailActionFailureReport = {
  actionId: MailActionId;
  destinationFolderId: string | null;
  conversationCount: number;
  failures: MailActionFailure[];
};

type FollowedConversation = { conversationId: string; label: string; pending: Set<string>; failureCode: string | null };

type FollowedAction = {
  actionId: MailActionId;
  destinationFolderId: string | null;
  startedAt: number;
  conversations: FollowedConversation[];
};

const record = (conversation: FollowedConversation, outcome: MailActionCommand): void => {
  if (PENDING_STATES.has(outcome.state)) return;
  conversation.pending.delete(outcome.id);
  if (!FAILED_STATES.has(outcome.state)) return;
  // An unclear outcome outranks a definite failure: the user has to check it, not repeat it.
  if (outcome.state === "needs_attention" || conversation.failureCode === null) conversation.failureCode = failureCode(outcome);
};

const isPending = (action: FollowedAction): boolean => action.conversations.some((conversation) => conversation.pending.size > 0);

/** The failure report of a finished action, or `null` when every change it saw was made. */
const failureReport = (action: FollowedAction): MailActionFailureReport | null => {
  const failures = action.conversations.flatMap((conversation) =>
    conversation.failureCode
      ? [{ conversationId: conversation.conversationId, label: conversation.label, code: conversation.failureCode }]
      : [],
  );
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
      conversations: readonly { conversationId: string; label: string; commands: readonly MailActionCommand[] }[];
      now?: number;
    }): MailActionFailureReport | null => {
      const action: FollowedAction = {
        actionId: params.actionId,
        destinationFolderId: params.destinationFolderId,
        startedAt: params.now ?? Date.now(),
        conversations: params.conversations.map((conversation) => {
          const followed: FollowedConversation = {
            conversationId: conversation.conversationId,
            label: conversation.label,
            pending: new Set(conversation.commands.map((command) => command.id)),
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
     * expired with a failure; an expired action reports the failures it saw and drops the commands
     * that still wait.
     */
    apply: (requested: readonly string[], outcomes: readonly MailActionCommand[], now = Date.now()): MailActionFailureReport[] => {
      const asked = new Set(requested);
      const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
      const reports: MailActionFailureReport[] = [];
      for (const action of actions) {
        for (const conversation of action.conversations) {
          for (const id of [...conversation.pending]) {
            if (asked.has(id)) record(conversation, byId.get(id) ?? { id, state: "confirmed", code: null });
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
