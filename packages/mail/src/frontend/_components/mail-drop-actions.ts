import type { MailListItem } from "../../service/workspace";
import type { MailAssigneeChoice } from "./mail-assign-picker";
import { mailDropMessages } from "./mail-drop-messages";
import type { MailDropAction } from "./mail-drop-targets";

type DropItem = Pick<MailListItem, "conversationId" | "workStatus" | "localTags" | "revision">;

/**
 * The workspace paths a drop runs through. Assignment and moving bring their own notices with Undo, as from their
 * menus; done and tags report here. Every path throws on failure, and the drop then offers to try again.
 */
export type MailDropHost = {
  /** The bulk assignment with a chosen person, or the assignment search when `choice` is null. */
  assign: (conversationIds: string[], choice: MailAssigneeChoice | null) => Promise<void>;
  move: (items: readonly DropItem[], folderId: string) => Promise<void>;
  /** Returns the conversations whose status changed. */
  complete: (conversationIds: string[], completion: "done" | "open") => Promise<string[]>;
  /** Returns the conversations that did not have the tag yet. */
  addTag: (conversationIds: string[], tagId: string) => Promise<string[]>;
  setTags: (conversationId: string, tagIds: string[], expectedRevision: number) => Promise<void>;
  rememberFolder: (folderId: string) => void;
  /** A short title names the outcome; the message under it says what changed. */
  success: (notice: { title: string; message: string }, undo?: { label: string; run: () => void }) => void;
  /** A failed drop changed nothing: the notice says so under the reason and offers the same drop again. */
  failed: (notice: { title: string; message: string; retryLabel: string }, retry: () => void) => void;
  error: (notice: { title: string; message: string }) => void;
  /** False once the workspace was disposed. */
  active: () => boolean;
};

export type MailDropText = { undo: string; assignFailed: string };

export const runMailDrop = async (params: {
  action: MailDropAction;
  items: readonly DropItem[];
  currentUserId: string | null;
  locale: string;
  host: MailDropHost;
  text: MailDropText;
}): Promise<void> => {
  const { action, items, host, text } = params;
  const t = mailDropMessages.resolve([params.locale]).t;
  const conversationIds = items.flatMap((item) => (item.conversationId ? [item.conversationId] : []));
  if (conversationIds.length === 0) return;
  const retry = () => void runMailDrop(params);
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
        const changed = await host.complete(conversationIds, "done");
        if (!host.active() || changed.length === 0) return;
        host.success(
          { title: t.doneTitle, message: t.markedDone({ count: changed.length }) },
          {
            label: text.undo,
            run: () =>
              void host.complete(changed, "open").then(
                () => host.active() && host.success({ title: t.undone, message: t.undoneBody }),
                (error: unknown) =>
                  host.active() && host.error({ title: t.undoFailed, message: error instanceof Error ? error.message : t.nothingChanged }),
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
