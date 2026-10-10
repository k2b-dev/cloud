import { announce, toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { SpaceItem } from "@/contracts";
import { readResponseError } from "../../../lib/response";
import type { spaceMessages } from "../../messages";
import { invalidateSpacesData } from "../workspace/workspace-events";
import { resolveCompletionClaim } from "./claim/claim";
import type { LeavingItems } from "./leaving";

type Messages = ReturnType<typeof spaceMessages.resolve>["t"];
type Completion = { spaceId: string; itemId: string; completed: boolean; claimId?: string; force?: true };

/** Completes or reopens one item; a refusal throws the server's reason, or `failure` when it gives none. */
export const setItemCompleted = async ({ spaceId, itemId, completed, claimId, force }: Completion, failure: string): Promise<SpaceItem> => {
  const response = await apiClient[":id"].items[":itemId"].completed.$post({
    param: { id: spaceId, itemId },
    json: { completed, claimId, force },
  });
  if (!response.ok) throw new Error(await readResponseError(response, failure));
  return response.json();
};

/** One completion change: the item as the view showed it before, and as the server returned it after. */
export type CompletionChange = {
  spaceId: string;
  previous: SpaceItem;
  changed: SpaceItem;
  /** The reader, whose own claim goes with the change; someone else's claim is taken over only after a confirmation. */
  currentUserId?: string;
};

/**
 * Sets the previous completion again and puts the item back in the status and position it had, because completing
 * moves an open task to a done status and reopening moves it back to the first open one. The claim the change left is
 * handled as for any completion change. Resolves to false when the reader declines to take a claim over.
 */
export const restoreCompletion = async ({ spaceId, previous, changed, currentUserId }: CompletionChange, t: Messages): Promise<boolean> => {
  const completed = Boolean(previous.completedAt);
  const claim = currentUserId ? await resolveCompletionClaim(changed.claim, currentUserId, completed, t) : {};
  if (!claim) return false;
  const response = await apiClient[":id"].items[":itemId"].move.$post({
    param: { id: spaceId, itemId: previous.id },
    json: { columnId: previous.columnId, rank: previous.rank, completed, ...claim },
  });
  if (!response.ok) throw new Error(await readResponseError(response, t.updateFailed));
  return true;
};

/** Lets a view show the item in place while Undo runs, and decide what to show once it has finished. */
export type UndoTracking = {
  /** Undo starts. */
  undoing: () => void;
  /** Undo finished; `restored` is false when it failed or the reader declined to take a claim over. */
  undone: (restored: boolean) => void;
};

/**
 * Confirms a completion the view no longer shows where the user acted, such as a row the status filter now hides or
 * a card a shortcut moved to the done column. Undo restores the item as it was. The toast outlives the row or card
 * that showed it, because they are gone by design. Returns the toast's Undo, for a view that offers it elsewhere too,
 * such as unticking the row while it is still leaving; it closes the toast and runs once unless it failed.
 */
export const confirmCompletion = (change: CompletionChange, t: Messages, tracking?: UndoTracking): (() => void) => {
  let used = false;
  const undo = () => {
    if (used) return;
    used = true;
    notice.dismiss();
    tracking?.undoing();
    void restoreCompletion(change, t).then(
      async (restored) => {
        used = restored;
        if (restored) await invalidateSpacesData().catch(() => toast.error(t.listRefreshFailed));
        tracking?.undone(restored);
      },
      (error: Error) => {
        used = false;
        toast.error(error.message);
        tracking?.undone(false);
      },
    );
  };
  const notice = toast.success(change.previous.completedAt ? t.itemReopened : t.itemCompleted, {
    action: { label: t.undo, onClick: undo },
  });
  return undo;
};

/**
 * Shows a completion change once the server has it. The view is read again: an item it still lists stays, and a
 * screen reader is told, as the item may move. An item it no longer lists stays a moment as the reader left it, then
 * collapses, and the toast confirms the change with Undo, which unticking the item while it leaves runs too. When the
 * view cannot be read again, the toast still confirms the change with Undo, and the item shows what the view last read.
 */
export const showCompletion = async (
  change: CompletionChange & { completed: boolean },
  view: { leaving: LeavingItems<SpaceItem>; isListed: (itemId: string) => boolean; refreshFailed: () => void },
  t: Messages,
): Promise<void> => {
  const { previous, completed } = change;
  const { leaving } = view;
  const id = previous.id;
  const refreshed = await invalidateSpacesData().then(
    () => true,
    () => false,
  );
  if (refreshed && view.isListed(id)) {
    leaving.release(id);
    announce(completed ? t.itemCompleted : t.itemReopened);
    return;
  }
  if (refreshed) leaving.leave(id);
  else {
    leaving.release(id);
    view.refreshFailed();
  }
  // Undo shows the item as it was while it runs. An item that has already gone comes back with the refresh after Undo.
  let shown = false;
  const undo = confirmCompletion(change, t, {
    undoing: () => {
      shown = leaving.held().has(id);
      if (shown) leaving.hold(previous, Boolean(previous.completedAt));
    },
    undone: (restored) => {
      if (restored) return leaving.release(id);
      if (!shown) return;
      leaving.hold(previous, completed);
      leaving.leave(id);
      leaving.offerUndo(id, undo);
    },
  });
  if (refreshed) leaving.offerUndo(id, undo);
};
