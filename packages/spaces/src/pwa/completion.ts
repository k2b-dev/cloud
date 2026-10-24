import { toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { spacesMessages } from "@/service/messages";
import { isOwnClaim } from "../frontend/[id]/_components/shared/claim/claim";
import { readResponseError } from "../frontend/lib/response";
import { myTasksMessages } from "./messages";

export type CompletionOutcome = "saved" | "refused" | "failed";
type Target = { shortId: string; spaceShortId: string; title: string; spaceName: string };

/** The task's current claim, read only after a refusal; null when it has none or cannot be read. */
const currentClaim = async (item: Target) => {
  const response = await apiClient[":id"].items[":itemId"]
    .$get({ param: { id: item.spaceShortId, itemId: item.shortId } })
    .catch(() => null);
  return response?.ok ? ((await response.json()).claim ?? null) : null;
};

/**
 * Sets a task's completion as the list and the task page do. A refusal that a retry cannot change is said in a
 * toast here; a failure (offline, unreachable, server error) is left to the caller, which offers Retry.
 */
export async function saveCompletion(params: {
  item: Target;
  completed: boolean;
  userId: string;
  locale: string;
  claimId?: string;
}): Promise<CompletionOutcome> {
  const { item, completed, claimId } = params;
  const t = myTasksMessages.resolve([params.locale]).t;
  const refused = (message: string): CompletionOutcome => {
    toast.error(message);
    return "refused";
  };
  const response = await apiClient[":id"].items[":itemId"].completed
    .$post({ param: { id: item.spaceShortId, itemId: item.shortId }, json: { completed, claimId } })
    // Offline or unreachable: the same Retry as a failed answer.
    .catch(() => null);
  if (!response) return "failed";
  if (response.ok) return "saved";
  if (response.status === 409 && completed && !claimId) {
    // A claimed task: the person's own claim completes it, as on the web; someone else's is named.
    const claim = await currentClaim(item);
    if (claim && isOwnClaim(claim, params.userId)) return saveCompletion({ ...params, claimId: claim.id });
    if (claim) return refused(t.claimed({ title: item.title, name: claim.displayName }));
  }
  if (response.status === 403) return refused(t.notAllowed({ space: item.spaceName }));
  if (response.status === 404) return refused(t.gone({ title: item.title }));
  // Unfinished blockers; the server already words the reason in the person's language.
  if (response.status === 409) return refused(await readResponseError(response, spacesMessages(params.locale).completeBlockersFirst));
  return "failed";
}
