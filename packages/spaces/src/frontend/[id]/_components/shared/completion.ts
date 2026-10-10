import { toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { SpaceItem } from "@/contracts";
import { readResponseError } from "../../../lib/response";
import type { spaceMessages } from "../../messages";
import { invalidateSpacesData } from "../workspace/workspace-events";
import { resolveCompletionClaim } from "./claim/claim";

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
