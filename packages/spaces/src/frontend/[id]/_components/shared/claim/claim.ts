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

/**
 * Claim fields of a change a claim guards (completion, reopening, a wormhole transfer): the holder's own claim ID, or a
 * confirmed take-over of the exact claim seen.
 */
export type ClaimFields = { claimId?: string; force?: true };

type GuardedChange = "complete" | "reopen" | "transfer";

/**
 * Claims coordinate work and do not lock it: a guarded change of a task someone else claimed asks once and then takes
 * their claim over in the same request. Resolves to null when the person declines, so nothing changes.
 */
const resolveClaim = async (
  claim: SpaceItemClaim | null | undefined,
  currentUserId: string,
  change: GuardedChange,
  t: Messages,
): Promise<ClaimFields | null> => {
  const other = othersClaim(claim, currentUserId);
  if (!other) return { claimId: ownClaimId(claim, currentUserId) };
  const name = other.displayName;
  const [question, confirmText] =
    change === "complete"
      ? [t.takeOverAndComplete({ name }), t.takeOverAndCompleteAction]
      : change === "reopen"
        ? [t.takeOverAndReopen({ name }), t.takeOverAndReopenAction]
        : [t.takeOverAndMove({ name }), t.takeOverAndMoveAction];
  const confirmed = await prompts.confirm(question, { title: t.takeOverTitle, icon: "ti ti-replace", confirmText, cancelText: t.cancel });
  return confirmed ? { claimId: other.id, force: true } : null;
};

/** Claim fields to complete or reopen a task; see `resolveClaim`. */
export const resolveCompletionClaim = (claim: SpaceItemClaim | null | undefined, currentUserId: string, completed: boolean, t: Messages) =>
  resolveClaim(claim, currentUserId, completed ? "complete" : "reopen", t);

/** Claim fields to send a task through a wormhole, which ends its claim; see `resolveClaim`. */
export const resolveTransferClaim = (claim: SpaceItemClaim | null | undefined, currentUserId: string, t: Messages) =>
  resolveClaim(claim, currentUserId, "transfer", t);

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
