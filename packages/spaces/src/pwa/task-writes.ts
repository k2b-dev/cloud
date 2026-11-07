import { apiClient } from "@/api/client";
import type { UpdateItem } from "@/contracts";
import { type ClaimPass, type CompletionOutcome, sendWithClaim } from "./completion";
import type { PwaTask } from "./task";

type Answer = Pick<Response, "ok" | "status" | "json">;

/**
 * Changes properties of a task through the app's API client, which renews an expired app session and repeats the
 * request; offline or unreachable answers null.
 */
export const patchTask = async (task: Pick<PwaTask, "spaceShortId" | "shortId">, body: UpdateItem): Promise<Answer | null> => {
  try {
    return await apiClient[":id"].items[":itemId"].$patch({ param: { id: task.spaceShortId, itemId: task.shortId }, json: body });
  } catch {
    return null;
  }
};

/**
 * Moves a task to another status without dragging: the server puts it at the top, or before `beforeItemId`. A done
 * status completes it, with the same claim decision as checking it off.
 */
export const moveTask = (params: {
  task: Pick<PwaTask, "spaceShortId" | "shortId" | "title" | "spaceName">;
  statusId: string;
  beforeItemId?: string;
  afterItemId?: string;
  userId: string;
  locale: string;
}): Promise<CompletionOutcome> =>
  sendWithClaim({
    item: params.task,
    userId: params.userId,
    locale: params.locale,
    send: (claim?: ClaimPass) =>
      apiClient[":id"].items[":itemId"].move.$post({
        param: { id: params.task.spaceShortId, itemId: params.task.shortId },
        json: {
          columnId: params.statusId,
          ...(params.beforeItemId ? { beforeItemId: params.beforeItemId } : params.afterItemId ? { afterItemId: params.afterItemId } : {}),
          ...claim,
        },
      }),
  });
