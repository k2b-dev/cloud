import type { CapabilityActionReview } from "../contracts/capabilities";
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
  approval?: "none" | "rememberable" | "always";
  hasReview: boolean;
  action: string;
  review: () => Promise<CapabilityActionReview | null>;
  signal?: AbortSignal;
};

/** Core routine gate. A review can narrow a mandate, never grant authority. */
export const authorizeBackgroundActionWith = async (
  input: BackgroundActionInput,
  authorizeCapability: typeof aiChatTasks.authorizeCapability,
): Promise<CapabilityActionReview | null> => {
  await authorizeCapability({
    mandate: input.mandate,
    appId: input.appId,
    capabilityId: input.capabilityId,
    kind: input.kind,
    input: input.args,
    approval: input.approval,
  });
  if (input.kind === "query" || input.approval === "none") return null;
  input.signal?.throwIfAborted();
  if (input.approval !== "rememberable") {
    await aiChatTasks.markNeedsApproval({ turnId: input.turnId, action: input.action });
    throw new AiBackgroundApprovalRequiredError(input.action);
  }
  let review: CapabilityActionReview | null = null;
  if (input.hasReview) {
    try {
      review = await input.review();
    } catch {
      // An unavailable review cannot authorize an unattended effect.
      input.signal?.throwIfAborted();
    }
  }
  input.signal?.throwIfAborted();
  if (review?.approvalScope) return review;
  await aiChatTasks.markNeedsApproval({ turnId: input.turnId, action: input.action });
  throw new AiBackgroundApprovalRequiredError(input.action);
};

export const authorizeBackgroundAction = (input: BackgroundActionInput): Promise<CapabilityActionReview | null> =>
  authorizeBackgroundActionWith(input, aiChatTasks.authorizeCapability);
