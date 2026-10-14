import { MAIL_ACTION_OUTCOME_TTL_MS, MAX_CONVERSATION_ACTION_MESSAGES } from "../../command-outcomes";
import type { ConversationTriageUndoOutcome } from "../../contracts";
import type { MailActionCommand, MailActionQueuedCommand, MailActionSettlement } from "./mail-action-outcomes";
import type { MailActionQueue } from "./mail-action-queue";
import type { MailActionId } from "./mail-actions";
import { MAIL_BULK_NO_PROVIDER_PLACEMENT, MAIL_BULK_QUEUE_FAILED, type MailBulkTarget } from "./mail-bulk-actions";
import type { MailListOptimisticField } from "./mail-list-optimistic";

export type MailWorkspaceActionOptions = {
  targets?: MailBulkTarget[];
  destinationFolderId?: string;
  silent?: boolean;
};

export type MailAutoReadDecision = "ignore" | "wait" | "consume" | "read";

export type MailWorkspaceActionExecution = {
  correlationId: string;
  idempotencyKeys: Map<string, string>;
  targets?: MailBulkTarget[];
  destinationResolved?: boolean;
  destinationFolderId?: string | null;
};

export const decideMailAutoReadIntent = (params: {
  intent: number;
  consumedIntent: number;
  busy: boolean;
  unread: boolean;
  canSubmit: boolean;
}): MailAutoReadDecision => {
  if (params.intent === params.consumedIntent) return "ignore";
  if (params.busy) return "wait";
  return params.unread && params.canSubmit ? "read" : "consume";
};

type ActionFailure = {
  conversationId: string;
  label: string;
  message: string;
  submittedPlacements: number;
};

export type MailWorkspaceActionRunnerHost = {
  queue: MailActionQueue;
  resolveTargets: (actionId: MailActionId) => MailBulkTarget[];
  chooseDestinationFolder: () => Promise<string | null>;
  roleDestinationFolderId: (actionId: MailActionId) => string | null;
  applyOptimistic: (actionId: MailActionId, targets: readonly MailBulkTarget[], destinationFolderId: string | null) => void;
  restore: (target: MailBulkTarget) => void;
  hold: (target: MailBulkTarget) => void;
  release: (target: MailBulkTarget) => void;
  offerUndo: (params: {
    actionId: MailActionId;
    targets: readonly MailBulkTarget[];
    destinationFolderId: string | null;
    undo: () => Promise<void>;
  }) => void;
  announce: (actionId: MailActionId | "undo", targets: readonly MailBulkTarget[]) => void;
  submit: (params: {
    actionId: MailActionId;
    target: MailBulkTarget;
    sourceFolderId: string;
    destinationFolderId?: string;
    correlationId: string;
    idempotencyKey: string;
  }) => Promise<readonly MailActionCommand[]>;
  submitUndo: (params: { target: MailBulkTarget; commandIds: string[] }) => Promise<readonly ConversationTriageUndoOutcome[]>;
  /** Returns a stop handle for Undo. Inverse failures use Undo's own error notice. */
  followOutcomes: (params: {
    actionId: MailActionId;
    destinationFolderId: string | null;
    target: MailBulkTarget;
    commands: readonly MailActionQueuedCommand[];
    reportFailures: boolean;
    onSettled: (settlement: MailActionSettlement) => void;
    onFailure: () => void;
  }) => () => void;
  reconcile: () => Promise<boolean>;
  releaseOnNextSnapshot: (target: MailBulkTarget, wanted: () => boolean) => void;
  showMissingTarget: () => Promise<void>;
  showNothingToMove: () => void;
  showFailures: (failures: readonly ActionFailure[], params: { targetCount: number; retry: () => Promise<void> }) => void;
  showUndoFailed: (targets: readonly MailBulkTarget[], destinationFolderId: string | null) => void;
  showError: (error: unknown) => void;
};

export const mailOptimisticFields = (actionId: MailActionId): MailListOptimisticField[] =>
  actionId === "mark_read" || actionId === "mark_unread" ? ["unread"] : actionId === "flag" || actionId === "unflag" ? ["flagged"] : [];

/**
 * One target per conversation, with its own copy of the folders. In a message list, several
 * selected rows can belong to one conversation; the action runs once on the union of their folders
 * and messages, and on the whole conversation as soon as one target stands for it.
 * The copy keeps the action on the folders it started from while the list store updates.
 */
const mergeConversationTargets = (targets: readonly MailBulkTarget[]): MailBulkTarget[] => {
  const merged = new Map<string, MailBulkTarget>();
  for (const target of targets) {
    const existing = merged.get(target.conversationId);
    const messageIds = existing
      ? existing.messageIds && target.messageIds && [...new Set([...existing.messageIds, ...target.messageIds])]
      : target.messageIds;
    merged.set(target.conversationId, {
      conversationId: target.conversationId,
      label: (existing ?? target).label,
      sourceFolderIds: [...new Set([...(existing?.sourceFolderIds ?? []), ...target.sourceFolderIds])],
      ...(messageIds ? { messageIds: [...messageIds] } : {}),
    });
  }
  return [...merged.values()];
};

/**
 * The targets without their placements in the destination folder. A target that is only there has
 * nothing to move and drops out. A target in no folder at all, such as a failed send that never
 * reached one, stays, so the action reports that instead of claiming it is already there.
 */
export const removeDestinationPlacements = (targets: readonly MailBulkTarget[], destinationFolderId: string): MailBulkTarget[] =>
  targets.flatMap((target) => {
    const sourceFolderIds = target.sourceFolderIds.filter((sourceFolderId) => sourceFolderId !== destinationFolderId);
    return sourceFolderIds.length > 0 || target.sourceFolderIds.length === 0 ? [{ ...target, sourceFolderIds }] : [];
  });

const waitForUndo = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

export const runMailWorkspaceAction = async (
  actionId: MailActionId,
  options: MailWorkspaceActionOptions,
  host: MailWorkspaceActionRunnerHost,
  signal: AbortSignal,
  execution: MailWorkspaceActionExecution = { correlationId: crypto.randomUUID(), idempotencyKeys: new Map() },
): Promise<void> => {
  try {
    execution.targets ??= mergeConversationTargets(options.targets ?? host.resolveTargets(actionId));
    let targets = options.targets ? mergeConversationTargets(options.targets) : execution.targets;
    if (targets.length === 0) {
      if (!options.silent && !options.targets) await host.showMissingTarget();
      return;
    }
    if (actionId === "move" && !execution.destinationResolved) {
      execution.destinationFolderId = options.destinationFolderId ?? (await host.chooseDestinationFolder());
      execution.destinationResolved = true;
    }
    const destination = actionId === "move" ? execution.destinationFolderId : undefined;
    if (signal.aborted || (actionId === "move" && !destination)) return;
    const knownDestination = destination ?? host.roleDestinationFolderId(actionId);
    if (knownDestination) targets = removeDestinationPlacements(targets, knownDestination);
    if (targets.length === 0) {
      if (!options.silent) host.showNothingToMove();
      return;
    }
    const removing = mailOptimisticFields(actionId).length === 0;
    host.applyOptimistic(actionId, targets, knownDestination ?? null);
    let undone = false;
    const failures: ActionFailure[] = [];
    const jobs: {
      target: MailBulkTarget;
      cancel: () => boolean;
      result: Promise<{ commands: MailActionQueuedCommand[]; failed: boolean }>;
      stop?: () => void;
    }[] = [];
    const undo = async () => {
      if (undone || signal.aborted) return;
      undone = true;
      const undoFailures = new Set<MailBulkTarget>();
      let requestPhases = jobs.length;
      const requestPhaseEnded = () => {
        requestPhases -= 1;
        if (requestPhases === 0 && undoFailures.size === 0 && !signal.aborted && !options.silent) host.announce("undo", targets);
      };
      const pending = jobs.map(async (job) => {
        if (job.cancel()) {
          host.restore(job.target);
          requestPhaseEnded();
          return;
        }
        host.hold(job.target);
        job.stop?.();
        try {
          const inverse = await (async (): Promise<MailActionQueuedCommand[]> => {
            try {
              const byId = new Map<string, ConversationTriageUndoOutcome>();
              let ids: string[] = [];
              let startedAt = 0;
              const submitRound = async () => {
                // Placements across several folders can exceed one Undo request's command-ID budget.
                const outcomes: ConversationTriageUndoOutcome[] = [];
                for (let offset = 0; offset < ids.length; offset += MAX_CONVERSATION_ACTION_MESSAGES) {
                  outcomes.push(
                    ...(await host.submitUndo({
                      target: job.target,
                      commandIds: ids.slice(offset, offset + MAX_CONVERSATION_ACTION_MESSAGES),
                    })),
                  );
                  if (signal.aborted) return;
                }
                for (const id of ids) {
                  byId.set(id, outcomes.find((outcome) => outcome.id === id) ?? { id, outcome: "unavailable", inverse: null });
                }
                ids = ids.filter((id) => byId.get(id)?.outcome === "pending");
              };
              const queued = await host.queue.enqueue(job.target.conversationId, async () => {
                const submitted = await job.result;
                ids = [...new Set(submitted.commands.map((command) => command.id))];
                startedAt = Date.now();
                if (ids.length > 0) await submitRound();
                return submitted;
              }).result;
              if (!queued.ran) return [];
              if (queued.value.commands.length === 0) {
                if (!queued.value.failed) undoFailures.add(job.target);
                return [];
              }
              let attempt = 0;
              while (ids.length > 0 && !signal.aborted) {
                const remaining = MAIL_ACTION_OUTCOME_TTL_MS - (Date.now() - startedAt);
                if (remaining <= 0) break;
                await waitForUndo(Math.min(1_000 * 2 ** attempt++, 30_000, remaining), signal);
                await submitRound();
              }
              if (signal.aborted) return [];
              if (ids.length > 0 || [...byId.values()].some((outcome) => outcome.outcome === "unavailable")) undoFailures.add(job.target);
              return [...byId.values()].flatMap((outcome) => {
                if (outcome.outcome !== "reversed") return [];
                if (!outcome.inverse) {
                  undoFailures.add(job.target);
                  return [];
                }
                if (["failed", "cancelled", "needs_attention"].includes(outcome.inverse.state)) undoFailures.add(job.target);
                return [{ ...outcome.inverse, sourceFolderId: knownDestination ?? "" }];
              });
            } catch {
              if (!signal.aborted) undoFailures.add(job.target);
              return [];
            } finally {
              requestPhaseEnded();
            }
          })();
          if (inverse.length > 0) {
            const settlement = await new Promise<MailActionSettlement>((resolve) => {
              let finished = false;
              let stop = () => {};
              const finish = (settlement: MailActionSettlement) => {
                if (!settlement.ok) undoFailures.add(job.target);
                finished = true;
                signal.removeEventListener("abort", abort);
                resolve(settlement);
              };
              const abort = () => {
                stop();
                finish({ conversationId: job.target.conversationId, ok: false, expired: true });
              };
              stop = host.followOutcomes({
                actionId,
                destinationFolderId: null,
                target: job.target,
                commands: inverse,
                reportFailures: false,
                onSettled: finish,
                onFailure: () => finish({ conversationId: job.target.conversationId, ok: false, expired: false }),
              });
              if (signal.aborted) abort();
              else if (!finished) signal.addEventListener("abort", abort, { once: true });
            });
            if (!settlement.ok) undoFailures.add(job.target);
            await host.reconcile();
          }
        } catch {
          if (!signal.aborted) undoFailures.add(job.target);
        } finally {
          host.release(job.target);
        }
      });
      await Promise.all(pending);
      if (signal.aborted) return;
      await host.reconcile();
      if (undoFailures.size > 0) host.showUndoFailed([...undoFailures], knownDestination ?? null);
    };
    if (removing && !options.silent) host.offerUndo({ actionId, targets, destinationFolderId: knownDestination ?? null, undo });
    else if (!options.silent) host.announce(actionId, targets);

    for (const target of targets) {
      const commands: MailActionQueuedCommand[] = [];
      let submittedPlacements = 0;
      const queued = host.queue.enqueue(target.conversationId, async () => {
        try {
          if (target.sourceFolderIds.length === 0) throw new Error(MAIL_BULK_NO_PROVIDER_PLACEMENT);
          for (const sourceFolderId of target.sourceFolderIds) {
            const key = `${actionId}:${target.conversationId}:${sourceFolderId}:${destination ?? ""}`;
            let idempotencyKey = execution.idempotencyKeys.get(key);
            if (!idempotencyKey) {
              idempotencyKey = crypto.randomUUID();
              execution.idempotencyKeys.set(key, idempotencyKey);
            }
            const next = await host.submit({
              actionId,
              target,
              sourceFolderId,
              destinationFolderId: destination ?? undefined,
              correlationId: execution.correlationId,
              idempotencyKey,
            });
            commands.push(...next.map((command) => ({ ...command, sourceFolderId })));
            submittedPlacements += 1;
          }
          return { commands, failed: false };
        } catch (error) {
          host.restore(target);
          failures.push({
            conversationId: target.conversationId,
            label: target.label,
            message: error instanceof Error ? error.message : MAIL_BULK_QUEUE_FAILED,
            submittedPlacements,
          });
          return { commands, failed: true };
        }
      });
      const job: (typeof jobs)[number] = {
        target,
        cancel: queued.cancel,
        result: queued.result.then((result) => (result.ran ? result.value : { commands: [], failed: false })),
        stop: undefined,
      };
      jobs.push(job);
      void job.result.then((result) => {
        if (undone || signal.aborted || result.commands.length === 0) {
          if (!undone && !result.failed) {
            if (removing)
              void host.reconcile().then((fresh) => {
                if (undone || signal.aborted) return;
                if (fresh) host.release(target);
                else host.releaseOnNextSnapshot(target, () => !undone && !signal.aborted);
              });
            else host.release(target);
          }
          return;
        }
        if (options.silent) return;
        job.stop = host.followOutcomes({
          actionId,
          destinationFolderId: destination ?? null,
          target,
          commands: result.commands,
          reportFailures: true,
          onFailure: () => {
            if (!undone && !signal.aborted) host.restore(target);
          },
          onSettled: (settlement) => {
            if (undone || signal.aborted) return;
            if (!settlement.ok && !settlement.expired) return;
            void host.reconcile().then((fresh) => {
              if (undone || signal.aborted) return;
              if (fresh || !removing) host.release(target);
              else host.releaseOnNextSnapshot(target, () => !undone && !signal.aborted);
            });
          },
        });
      });
    }
    await Promise.all(jobs.map((job) => job.result));
    if (signal.aborted) return;
    if (!removing) await host.reconcile();
    if (options.silent) for (const target of targets) host.release(target);
    failures.sort(
      (left, right) =>
        targets.findIndex((target) => target.conversationId === left.conversationId) -
        targets.findIndex((target) => target.conversationId === right.conversationId),
    );
    if (failures.length > 0 && !options.silent)
      host.showFailures(failures, {
        targetCount: targets.length,
        retry: () =>
          runMailWorkspaceAction(
            actionId,
            {
              ...options,
              targets: targets.filter((target) => failures.some((failure) => failure.conversationId === target.conversationId)),
            },
            host,
            signal,
            execution,
          ),
      });
  } catch (error) {
    if (!signal.aborted && !options.silent) host.showError(error);
  }
};
