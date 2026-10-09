import { prompts } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { SpaceItemClaim } from "@/contracts";
import { readResponseError } from "../../../../lib/response";
import type { spaceMessages } from "../../../messages";

type Messages = ReturnType<typeof spaceMessages.resolve>["t"];
type Target = { spaceId: string; itemId: string };

/** A claim held by the signed-in person; service accounts never use the browser UI. */
export const isOwnClaim = (claim: SpaceItemClaim | null | undefined, currentUserId: string) =>
  claim?.actor.kind === "user" && claim.actor.id === currentUserId;

/** The claim ID to send whenever completion changes; the holder completes or reopens a claimed task with it. */
export const ownClaimId = (claim: SpaceItemClaim | null | undefined, currentUserId: string) =>
  isOwnClaim(claim, currentUserId) ? claim!.id : undefined;

/** Someone else's claim, which a completion change by the signed-in person takes over. */
export const othersClaim = (claim: SpaceItemClaim | null | undefined, currentUserId: string) =>
  claim && !isOwnClaim(claim, currentUserId) ? claim : null;

/** Claim fields of a completion change: the holder's own claim ID, or a confirmed take-over of the exact claim seen. */
export type CompletionClaim = { claimId?: string; force?: true };

/**
 * Claims coordinate work and do not lock it: completing or reopening a task someone else claimed asks once and then
 * takes their claim over in the same request. Resolves to null when the person declines, so nothing changes.
 */
export const resolveCompletionClaim = async (
  claim: SpaceItemClaim | null | undefined,
  currentUserId: string,
  completed: boolean,
  t: Messages,
): Promise<CompletionClaim | null> => {
  const other = othersClaim(claim, currentUserId);
  if (!other) return { claimId: ownClaimId(claim, currentUserId) };
  const name = other.displayName;
  const confirmed = await prompts.confirm(completed ? t.takeOverAndComplete({ name }) : t.takeOverAndReopen({ name }), {
    title: t.takeOverTitle,
    icon: "ti ti-replace",
    confirmText: completed ? t.takeOverAndCompleteAction : t.takeOverAndReopenAction,
    cancelText: t.cancel,
  });
  return confirmed ? { claimId: other.id, force: true } : null;
};

/** Claims the task with a fresh browser-generated claim ID, exactly like a CLI worker. */
export const claimTask = async (target: Target, t: Messages) => {
  const response = await apiClient[":id"].items[":itemId"].claim.$post({
    param: { id: target.spaceId, itemId: target.itemId },
    json: { claimId: crypto.randomUUID() },
  });
  if (!response.ok) throw new Error(await readResponseError(response, t.claimFailed));
  return response.json();
};

/** Releases the observed claim; an optional handoff note is saved as progress first. */
export const releaseTask = async (target: Target, claimId: string, t: Messages, note?: string) => {
  const param = { id: target.spaceId, itemId: target.itemId };
  const content = note?.trim();
  if (content) {
    const progress = await apiClient[":id"].items[":itemId"].progress.$post({ param, json: { content, claimId } });
    if (!progress.ok) throw new Error(await readResponseError(progress, t.releaseFailed));
  }
  const response = await apiClient[":id"].items[":itemId"].release.$post({ param, json: { claimId } });
  if (!response.ok) throw new Error(await readResponseError(response, t.releaseFailed));
  return response.json();
};

/** Any writer takes over: force-release the exact observed claim, then claim the task for the current person. */
export const takeOverTask = async (target: Target, claim: SpaceItemClaim, t: Messages) => {
  const response = await apiClient[":id"].items[":itemId"].release.$post({
    param: { id: target.spaceId, itemId: target.itemId },
    json: { claimId: claim.id, force: true },
  });
  if (!response.ok) throw new Error(await readResponseError(response, t.takeOverFailed));
  return claimTask(target, t);
};

/** Asks for an optional handoff note; resolves to null when the person cancels the release. */
export const promptReleaseNote = async (t: Messages): Promise<string | null> => {
  const values = await prompts.form({
    title: t.releaseNoteTitle,
    icon: "ti ti-hand-stop",
    confirmText: t.releaseClaim,
    cancelText: t.cancel,
    fields: {
      note: {
        type: "text",
        multiline: true,
        lines: 3,
        maxLength: 5000,
        label: t.releaseNoteLabel,
        placeholder: t.releaseNotePlaceholder,
      },
    },
  });
  return values ? (values.note ?? "") : null;
};
