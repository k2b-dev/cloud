import { toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { SpaceItem } from "@/contracts";
import { readResponseError } from "../../../lib/response";
import type { spaceMessages } from "../../messages";
import { invalidateSpacesData } from "../workspace/workspace-events";

type Messages = ReturnType<typeof spaceMessages.resolve>["t"];
type Completion = { spaceId: string; itemId: string; completed: boolean; claimId?: string };

/** Completes or reopens one item; a refusal throws the server's reason, or `failure` when it gives none. */
export const setItemCompleted = async ({ spaceId, itemId, completed, claimId }: Completion, failure: string): Promise<SpaceItem> => {
  const response = await apiClient[":id"].items[":itemId"].completed.$post({
    param: { id: spaceId, itemId },
    json: { completed, claimId },
  });
  if (!response.ok) throw new Error(await readResponseError(response, failure));
  return response.json();
};

/**
 * Confirms a completion the view no longer shows where the user acted, such as a row the status filter now hides or
 * a card a shortcut moved to the done column. Undo sets the previous state of the same item again. The toast outlives
 * the row or card that showed it, because they are gone by design.
 */
export const confirmCompletion = (change: Omit<Completion, "claimId">, t: Messages): void => {
  const notice = toast.success(change.completed ? t.itemCompleted : t.itemReopened, {
    action: {
      label: t.undo,
      onClick: () => {
        notice.dismiss();
        void setItemCompleted({ ...change, completed: !change.completed }, t.updateFailed).then(
          () => invalidateSpacesData().catch(() => toast.error(t.listRefreshFailed)),
          (error: Error) => toast.error(error.message),
        );
      },
    },
  });
};
