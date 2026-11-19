import type { CodeVersionCardSnapshot } from "@k2b/cloud/contracts/code-version-cards";
import { CodeSubmissionOriginSchema } from "./review-contracts";

/** Project stored submission metadata to the compact public card origin. */
export function cardOrigin(raw: unknown): NonNullable<CodeVersionCardSnapshot["review"]>["origin"] {
  const origin = CodeSubmissionOriginSchema.safeParse(raw);
  return origin.success && origin.data.kind === "ai_chat"
    ? { kind: "ai_chat", conversationId: origin.data.conversationId, automaticAfterReview: origin.data.automaticAfterReview }
    : { kind: "cli" };
}
