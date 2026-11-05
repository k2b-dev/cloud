import { prompts, toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { spacesMessages } from "@/service/messages";
import { isOwnClaim } from "../frontend/[id]/_components/shared/claim/claim";
import { spaceMessages } from "../frontend/[id]/messages";
import { readResponseError } from "../frontend/lib/response";
import { myTasksMessages } from "./messages";

export type CompletionOutcome = "saved" | "refused" | "failed";
type Target = { shortId: string; spaceShortId: string; title: string; spaceName: string };
/** The claim a request carries: the person's own, or someone else's they chose to take over. */
export type ClaimPass = { claimId: string; force?: true };
/** What a change answers; a typed API client's response is one too. */
type Answer = Pick<Response, "ok" | "status" | "json">;

/** The task's current claim, read only after a refusal; null when it has none or cannot be read. */
const currentClaim = async (item: Target) => {
  const response = await apiClient[":id"].items[":itemId"]
    .$get({ param: { id: item.spaceShortId, itemId: item.shortId } })
    .catch(() => null);
  return response?.ok ? ((await response.json()).claim ?? null) : null;
};

/**
 * Sends a change that may meet a claim, as completing or moving into a done status does, with the web's decision:
 * the person's own claim goes along; someone else's asks once whether to take it over, then sends it with `force`.
 * A refusal that a retry cannot change is said in a toast here; a failure (offline, unreachable, server error) is left
 * to the caller, which offers Retry.
 */
export async function sendWithClaim(params: {
  item: Target;
  userId: string;
  locale: string;
  send: (claim?: ClaimPass) => Promise<Answer | null>;
}): Promise<CompletionOutcome> {
  const { item } = params;
  const t = myTasksMessages.resolve([params.locale]).t;
  const refused = (message: string): CompletionOutcome => {
    toast.error(message);
    return "refused";
  };
  const answer = async (response: Answer | null, claimed: boolean): Promise<CompletionOutcome> => {
    if (!response) return "failed";
    if (response.ok) return "saved";
    if (response.status === 409 && !claimed) {
      const claim = await currentClaim(item);
      if (claim && isOwnClaim(claim, params.userId)) return answer(await params.send({ claimId: claim.id }).catch(() => null), true);
      if (claim) {
        const s = spaceMessages.resolve([params.locale]).t;
        const confirmed = await prompts.confirm(s.takeOverHelp({ name: claim.displayName }), {
          title: s.takeOverTitle,
          icon: "ti ti-replace",
          confirmText: s.takeOverClaim,
          cancelText: s.cancel,
        });
        if (!confirmed) return "refused";
        return answer(await params.send({ claimId: claim.id, force: true }).catch(() => null), true);
      }
    }
    if (response.status === 403) return refused(t.notAllowed({ space: item.spaceName }));
    if (response.status === 404) return refused(t.gone({ title: item.title }));
    // Unfinished blockers; the server already words the reason in the person's language.
    if (response.status === 409) return refused(await readResponseError(response, spacesMessages(params.locale).completeBlockersFirst));
    if (response.status < 500 && response.status !== 429)
      return refused(await readResponseError(response, t.notAllowed({ space: item.spaceName })));
    return "failed";
  };
  // Offline or unreachable: the same Retry as a failed answer.
  return answer(await params.send().catch(() => null), false);
}

/** Sets a task's completion as the list and the task page do. */
export async function saveCompletion(params: {
  item: Target;
  completed: boolean;
  userId: string;
  locale: string;
}): Promise<CompletionOutcome> {
  const { item, completed } = params;
  return sendWithClaim({
    ...params,
    send: (claim) =>
      apiClient[":id"].items[":itemId"].completed.$post({
        param: { id: item.spaceShortId, itemId: item.shortId },
        json: { completed, ...(completed ? claim : {}) },
      }),
  });
}
