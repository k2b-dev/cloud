import type { ConversationCollaboration, MailAssignableUser } from "../../service/collaboration";
import type { ConversationLocalTags, LocalTag } from "../../service/local-tags";

export type MailCollaborationPatch = {
  assigneeUserIds?: string[];
  completion?: "done" | "open";
  snoozedUntil?: string | null;
};

export const applyMailCollaborationPatch = (
  current: ConversationCollaboration,
  patch: MailCollaborationPatch,
  assignableUsers: readonly MailAssignableUser[],
): ConversationCollaboration => {
  const knownAssignees = new Map([...current.assignees, ...assignableUsers].map((user) => [user.id, user]));
  return {
    ...current,
    ...(patch.assigneeUserIds !== undefined
      ? {
          assignees: patch.assigneeUserIds.flatMap((id) => {
            const user = knownAssignees.get(id);
            return user ? [{ id: user.id, uid: user.uid, displayName: user.displayName, avatarHash: user.avatarHash }] : [];
          }),
        }
      : {}),
    ...(patch.snoozedUntil !== undefined ? { snoozedUntil: patch.snoozedUntil } : {}),
    ...(patch.completion !== undefined
      ? { workStatus: patch.completion === "done" ? ("done" as const) : ("needs_action" as const), snoozedUntil: null }
      : {}),
  };
};

export const applyMailTagIds = (
  current: ConversationLocalTags,
  availableTags: readonly LocalTag[],
  tagIds: readonly string[],
): ConversationLocalTags => {
  const currentById = new Map(current.tags.map((tag) => [tag.id, tag]));
  const availableById = new Map(availableTags.map((tag) => [tag.id, tag]));
  return {
    ...current,
    tags: tagIds.flatMap((tagId) => {
      const tag = availableById.get(tagId) ?? currentById.get(tagId);
      return tag ? [tag] : [];
    }),
  };
};

export type MailDetailUpdateOperation =
  | { kind: "collaboration"; patch: MailCollaborationPatch }
  | { kind: "tags"; tagIds: string[] }
  | { kind: "reminder"; dueAt: string }
  | { kind: "cancel_reminder" };

const coalesceOperation = (
  current: MailDetailUpdateOperation | undefined,
  incoming: MailDetailUpdateOperation,
): MailDetailUpdateOperation | null => {
  if (!current || current.kind !== incoming.kind) return null;
  if (current.kind === "collaboration" && incoming.kind === "collaboration") {
    if (
      (current.patch.completion !== undefined && incoming.patch.snoozedUntil !== undefined) ||
      (current.patch.snoozedUntil !== undefined && incoming.patch.completion !== undefined)
    ) {
      return null;
    }
    return { kind: "collaboration", patch: { ...current.patch, ...incoming.patch } };
  }
  if (incoming.kind === "tags" || incoming.kind === "reminder") return incoming;
  return current;
};

export const queuedCollaborationPatch = (operations: readonly MailDetailUpdateOperation[]): MailCollaborationPatch => {
  const patch: MailCollaborationPatch = {};
  for (const operation of operations) {
    if (operation.kind === "collaboration") Object.assign(patch, operation.patch);
  }
  return patch;
};

export const queuedTagIds = (operations: readonly MailDetailUpdateOperation[]): string[] | null => {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    if (operation?.kind === "tags") return operation.tagIds;
  }
  return null;
};

export const queuedReminderDueAt = (operations: readonly MailDetailUpdateOperation[]): { pending: boolean; dueAt: string | null } => {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    if (operation?.kind === "reminder") return { pending: true, dueAt: operation.dueAt };
    if (operation?.kind === "cancel_reminder") return { pending: true, dueAt: null };
  }
  return { pending: false, dueAt: null };
};

export const createMailDetailUpdateQueue = <Result>(options: {
  run: (operation: MailDetailUpdateOperation, signal: AbortSignal) => Promise<Result>;
  onSuccess: (result: Result, operation: MailDetailUpdateOperation, queued: readonly MailDetailUpdateOperation[]) => void;
  onError: (error: Error, operation: MailDetailUpdateOperation) => void | Promise<void>;
}) => {
  let queued: MailDetailUpdateOperation[] = [];
  let active: MailDetailUpdateOperation | null = null;
  let controller: AbortController | null = null;
  let generation = 0;

  const drain = async (expectedGeneration: number): Promise<void> => {
    if (active || expectedGeneration !== generation) return;
    const operation = queued.shift();
    if (!operation) return;

    active = operation;
    const currentController = new AbortController();
    controller = currentController;
    try {
      const result = await options.run(operation, currentController.signal);
      if (expectedGeneration !== generation) return;
      options.onSuccess(result, operation, queued.slice());
    } catch (cause) {
      if (expectedGeneration !== generation || currentController.signal.aborted) return;
      queued = [];
      await options.onError(cause instanceof Error ? cause : new Error(String(cause)), operation);
    } finally {
      if (expectedGeneration === generation) {
        active = null;
        if (controller === currentController) controller = null;
        void drain(expectedGeneration);
      }
    }
  };

  return {
    enqueue(operation: MailDetailUpdateOperation) {
      const replacement = coalesceOperation(queued.at(-1), operation);
      if (replacement) queued[queued.length - 1] = replacement;
      else queued.push(operation);
      void drain(generation);
    },
    pending(): readonly MailDetailUpdateOperation[] {
      return active ? [active, ...queued] : queued.slice();
    },
    reset() {
      generation += 1;
      queued = [];
      active = null;
      controller?.abort();
      controller = null;
    },
  };
};
