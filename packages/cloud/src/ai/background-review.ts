import type { CapabilityActionPolicy, CapabilityActionReviewData } from "../contracts/capabilities";
import { aiChatTasks } from "./chat-tasks";

export class AiBackgroundApprovalRequiredError extends Error {
  readonly code = "NEEDS_APPROVAL";

  constructor(readonly action: string) {
    super(
      `NEEDS_APPROVAL: ${action} needs the user's approval every time, and routines never ask. Stop and say in one sentence what was missing.`,
    );
    this.name = "AiBackgroundApprovalRequiredError";
  }
}

type BackgroundActionInput = {
  turnId: string;
  mandate: { id: string; revision: number };
  appId: string;
  capabilityId: string;
  kind: "query" | "action";
  args: unknown;
  policy?: CapabilityActionPolicy;
  approval?: "none" | "rememberable" | "always";
  hasReview: boolean;
  action: string;
  review: () => Promise<CapabilityActionReviewData | null>;
  signal?: AbortSignal;
};

/** Core routine gate. A review can narrow a mandate, never grant authority. */
export const authorizeBackgroundActionWith = async (
  input: BackgroundActionInput,
  authorizeCapability: typeof aiChatTasks.authorizeCapability,
): Promise<CapabilityActionReviewData | null> => {
  // These declarations can never be granted to a routine. Stop with the approval state even if a stale grant exists.
  if (input.kind === "action" && input.policy && (!("silent" in input.policy) || input.policy.routines === false)) {
    await aiChatTasks.markNeedsApproval({ turnId: input.turnId, action: input.action });
    throw new AiBackgroundApprovalRequiredError(input.action);
  }
  await authorizeCapability({
    mandate: input.mandate,
    appId: input.appId,
    capabilityId: input.capabilityId,
    kind: input.kind,
    input: input.args,
    approval: input.approval,
    ...(input.policy ? { policy: input.policy } : {}),
  });
  if (input.kind === "query" || (!input.policy && input.approval === "none")) return null;
  input.signal?.throwIfAborted();
  if (!input.policy && input.approval !== "rememberable") {
    await aiChatTasks.markNeedsApproval({ turnId: input.turnId, action: input.action });
    throw new AiBackgroundApprovalRequiredError(input.action);
  }
  let review: CapabilityActionReviewData | null = null;
  if (input.hasReview && !input.signal?.aborted) {
    try {
      review = await input.review();
    } catch {
      // An unavailable review cannot authorize an unattended effect.
      input.signal?.throwIfAborted();
    }
  }
  input.signal?.throwIfAborted();
  if (review && (input.policy ? "sentence" in review && review.ask === undefined : !("sentence" in review) && review.approvalScope))
    return review;
  await aiChatTasks.markNeedsApproval({ turnId: input.turnId, action: input.action });
  throw new AiBackgroundApprovalRequiredError(input.action);
};

export const authorizeBackgroundAction = (input: BackgroundActionInput): Promise<CapabilityActionReviewData | null> =>
  authorizeBackgroundActionWith(input, aiChatTasks.authorizeCapability);
