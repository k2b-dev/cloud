import { toast } from "@k2b/ui";
import { apiClient } from "../../api/client";
import type { ConversationLocalTags } from "../../service/local-tags";
import type { MailListItem } from "../../service/workspace";
import { readApiError } from "./api-response";
import type { MailAssigneeChoice } from "./mail-assign-picker";
import { mailDropMessages } from "./mail-drop-messages";
import type { MailDropAction } from "./mail-drop-targets";

export type MailDropItem = Pick<MailListItem, "conversationId" | "workStatus" | "snoozedUntil" | "localTags" | "revision">;

/** The work state a done drop changed, which its Undo puts back. */
export type MailDropWorkState = Pick<MailListItem, "workStatus" | "snoozedUntil">;

/**
 * The workspace paths a drop runs through. Assignment and moving bring their own notices with Undo, as from their
 * menus; done and tags report here. Every path throws on failure, and the drop then offers to try again.
 */
export type MailDropHost<Item extends MailDropItem = MailDropItem> = {
  /** The bulk assignment with a chosen person, or the assignment search when `choice` is null. */
  assign: (conversationIds: string[], choice: MailAssigneeChoice | null) => Promise<void>;
  /** Moves exactly the dragged rows: in a message list, rows of one conversation can sit in different folders. */
  move: (items: readonly Item[], folderId: string) => Promise<void>;
  /**
   * Marks the conversations done. Returns the ones whose status changed, each with its new revision, and how many the
   * server did not find, such as one that left the mailbox meanwhile; throws only when the request as a whole failed.
   */
  complete: (conversationIds: string[]) => Promise<{ changed: Array<{ conversationId: string; revision: number }>; failed: number }>;
  /**
   * Puts the conversations' earlier work state back, each at the revision the drop left; a conversation changed since
   * then refuses it. Throws after trying every conversation when one of them failed.
   */
  restoreWork: (entries: Array<{ conversationId: string; state: MailDropWorkState; expectedRevision: number }>) => Promise<void>;
  /** Returns the conversations that did not have the tag yet. */
  addTag: (conversationIds: string[], tagId: string) => Promise<string[]>;
  setTags: (conversationId: string, tagIds: string[], expectedRevision: number) => Promise<void>;
  rememberFolder: (folderId: string) => void;
  /** A short title names the outcome; the message under it says what changed. */
  success: (notice: { title: string; message: string }, undo?: { label: string; run: () => void }) => void;
  /** A failed drop changed nothing: the notice says so under the reason and offers the same drop again through `retry`. */
  failed: (notice: { title: string; message: string; retryLabel: string }, retry: () => void) => void;
  error: (notice: { title: string; message: string }) => void;
  /** False once the workspace was disposed. */
  active: () => boolean;
};

export type MailDropText = { undo: string; assignFailed: string };

export const runMailDrop = async <Item extends MailDropItem>(params: {
  action: MailDropAction;
  items: readonly Item[];
  currentUserId: string | null;
  locale: string;
  host: MailDropHost<Item>;
  text: MailDropText;
  /** Runs the same drop again under the caller's rules (write access, no structure change running). */
  retry: () => void;
}): Promise<void> => {
  const { action, items, host, text, retry } = params;
  const t = mailDropMessages.resolve([params.locale]).t;
  // In a message list several rows can belong to one conversation; every request names a conversation once.
  const conversationIds = [...new Set(items.flatMap((item) => (item.conversationId ? [item.conversationId] : [])))];
  if (conversationIds.length === 0) return;
  try {
    switch (action.kind) {
      case "assign-me":
        if (!params.currentUserId) return;
        return await host.assign(conversationIds, { mode: "add", userId: params.currentUserId, name: null });
      case "assign":
        return await host.assign(conversationIds, { mode: "add", userId: action.userId, name: action.name });
      case "choose-assignee":
        return await host.assign(conversationIds, null);
      case "move":
        host.rememberFolder(action.folderId);
        return await host.move(items, action.folderId);
      case "done": {
        const { changed, failed } = await host.complete(conversationIds);
        if (!host.active()) return;
        // A conversation that left the mailbox meanwhile cannot be tried again; the notice counts it.
        const missing = failed > 0 ? ` ${t.notFound({ count: failed })}` : "";
        if (changed.length === 0) {
          if (failed > 0) host.error({ title: t.notSaved, message: `${t.notFound({ count: failed })} ${t.nothingChanged}` });
          return;
        }
        // Undo puts back each conversation's status and snooze from before the drop, at the revision the drop left.
        const before = new Map(items.flatMap((item) => (item.conversationId ? [[item.conversationId, item] as const] : [])));
        host.success(
          { title: t.doneTitle, message: `${t.markedDone({ count: changed.length })}${missing}` },
          {
            label: text.undo,
            run: () =>
              void host
                .restoreWork(
                  changed.flatMap(({ conversationId, revision }) => {
                    const item = before.get(conversationId);
                    if (!item) return [];
                    // A snooze that ran out meanwhile would have woken the conversation anyway.
                    const snoozedUntil = item.snoozedUntil && Date.parse(item.snoozedUntil) > Date.now() ? item.snoozedUntil : null;
                    return [{ conversationId, state: { workStatus: item.workStatus, snoozedUntil }, expectedRevision: revision }];
                  }),
                )
                .then(
                  () => host.active() && host.success({ title: t.undone, message: t.undoneBody }),
                  (error: unknown) =>
                    host.active() &&
                    host.error({ title: t.undoFailed, message: error instanceof Error ? error.message : t.nothingChanged }),
                ),
          },
        );
        return;
      }
      case "tag": {
        const updated = await host.addTag(conversationIds, action.tagId);
        if (!host.active() || updated.length === 0) return;
        // Undo puts back each conversation's tags from before the drop; a conversation changed since then refuses it.
        const before = new Map(items.flatMap((item) => (item.conversationId ? [[item.conversationId, item] as const] : [])));
        host.success(
          { title: t.tagTitle, message: t.tagAdded({ name: action.name, count: updated.length }) },
          {
            label: text.undo,
            run: () =>
              void Promise.all(
                updated.flatMap((conversationId) => {
                  const item = before.get(conversationId);
                  return item
                    ? [
                        host.setTags(
                          conversationId,
                          item.localTags.map((tag) => tag.id),
                          item.revision + 1,
                        ),
                      ]
                    : [];
                }),
              ).then(
                () => host.active() && host.success({ title: t.undone, message: t.undoneBody }),
                (error: unknown) =>
                  host.active() && host.error({ title: t.undoFailed, message: error instanceof Error ? error.message : t.nothingChanged }),
              ),
          },
        );
        return;
      }
    }
  } catch (error) {
    if (!host.active()) return;
    const reason = error instanceof Error && error.message ? error.message : action.kind.startsWith("assign") ? text.assignFailed : null;
    host.failed(
      {
        title: t.notSaved,
        message: reason ? `${/[.!?]$/.test(reason) ? reason : `${reason}.`} ${t.nothingChanged}` : t.nothingChanged,
        retryLabel: t.tryAgain,
      },
      retry,
    );
  }
};

type MailDropRowPatch = Partial<Pick<MailListItem, "workStatus" | "snoozedUntil" | "revision" | "localTags">>;

const putTags = (mailboxId: string, conversationId: string, tagIds: string[], expectedRevision: number) =>
  apiClient.mailboxes[":mailboxId"].conversations[":conversationId"]["local-tags"].$put({
    param: { mailboxId, conversationId },
    json: { expectedRevision, tagIds },
  });

/**
 * The drop's host, built from the workspace's own paths when a drop runs: assigning, moving and completing come from
 * the workspace; the requests behind tags and the Undo of done, and the notices, live here with the drop's code. Each
 * request throws with the server's reason or the workspace's fallback; `apply` puts an answer on the rows, and
 * `refresh` reconciles the workspace, reporting its own failure under the given message.
 */
export const createMailDropHost = <Item extends MailDropItem>(base: {
  mailboxId: string;
  assign: MailDropHost<Item>["assign"];
  move: MailDropHost<Item>["move"];
  complete: MailDropHost<Item>["complete"];
  rememberFolder: MailDropHost<Item>["rememberFolder"];
  apply: (conversationId: string, patch: MailDropRowPatch) => void;
  applyTags: (answer: ConversationLocalTags) => void;
  refresh: (failed: string) => Promise<void>;
  data: {
    listItems: readonly Pick<MailListItem, "conversationId" | "localTags">[];
    localTags: readonly MailListItem["localTags"][number][];
  };
  t: () => { addTagsFailed: string; tagsRefreshFailed: string; updateTagsFailed: string };
  conversationText: () => { completionFailed: string };
  retryToast: (message: string, options: { title: string; retryLabel: string; retry: () => void }) => void;
  active: () => boolean;
}): MailDropHost<Item> => {
  const { mailboxId } = base;
  const patchWork = async (
    conversationId: string,
    json: { expectedRevision: number; completion?: "open" | "waiting" | "needs_action" | "done"; snoozedUntil?: string },
  ) => {
    const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].collaboration.$patch({
      param: { mailboxId, conversationId },
      json,
    });
    if (!response.ok) throw new Error(await readApiError(response, base.conversationText().completionFailed));
    return response.json();
  };
  return {
    assign: base.assign,
    move: base.move,
    complete: base.complete,
    rememberFolder: base.rememberFolder,
    /** Puts each conversation's work state back: the status first, then a snooze at the revision that change left. */
    restoreWork: async (entries) => {
      let failure: unknown = null;
      for (const { conversationId, state, expectedRevision } of entries) {
        if (!base.active()) return;
        try {
          // A conversation without a status before reopens to what its latest message says, as Reopen does.
          let result = await patchWork(conversationId, { expectedRevision, completion: state.workStatus ?? "open" });
          if (state.snoozedUntil)
            result = await patchWork(conversationId, { expectedRevision: result.revision, snoozedUntil: state.snoozedUntil });
          base.apply(conversationId, { workStatus: result.workStatus, snoozedUntil: result.snoozedUntil, revision: result.revision });
        } catch (error) {
          failure ??= error;
        }
      }
      await base.refresh(base.conversationText().completionFailed);
      if (failure) throw failure;
    },
    addTag: async (conversationIds, tagId) => {
      const response = await apiClient.mailboxes[":mailboxId"].conversations["local-tags"].$post({
        param: { mailboxId },
        json: { conversationIds, tagIds: [tagId] },
      });
      if (!response.ok) throw new Error(await readApiError(response, base.t().addTagsFailed));
      const result = await response.json();
      const tag = base.data.localTags.find((candidate) => candidate.id === tagId);
      for (const conversationId of result.updatedConversationIds) {
        const row = base.data.listItems.find((candidate) => candidate.conversationId === conversationId);
        if (row && tag) base.apply(conversationId, { localTags: [...row.localTags, tag] });
      }
      await base.refresh(base.t().tagsRefreshFailed);
      return result.updatedConversationIds;
    },
    setTags: async (conversationId, tagIds, expectedRevision) => {
      const response = await putTags(mailboxId, conversationId, tagIds, expectedRevision);
      if (!response.ok) throw new Error(await readApiError(response, base.t().updateTagsFailed));
      base.applyTags(await response.json());
    },
    success: ({ title, message }, undo) =>
      void toast.success(message, {
        title,
        ...(undo ? { duration: 8_000, action: { label: undo.label, variant: "ghost" as const, onClick: undo.run } } : {}),
      }),
    failed: ({ title, message, retryLabel }, retry) => base.retryToast(message, { title, retryLabel, retry }),
    error: ({ title, message }) => void toast.error(message, { title }),
    active: base.active,
  };
};
