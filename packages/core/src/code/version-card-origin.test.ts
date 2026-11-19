import { expect, test } from "bun:test";
import { CodeVersionCardSnapshotSchema } from "@k2b/cloud/contracts/code-version-cards";
import { CodeSubmissionOriginSchema } from "./review-contracts";
import { cardOrigin } from "./version-card-origin";

const conversationId = "77777777-7777-4777-8777-777777777777";
const schema = CodeVersionCardSnapshotSchema.shape.review.unwrap().shape.origin;

test("every stored submission origin projects to the strict public card contract", () => {
  for (const raw of [
    { kind: "cli" },
    { kind: "ai_chat", conversationId, automaticAfterReview: false },
    { kind: "ai_chat", conversationId, automaticAfterReview: false, cardAnchor: "tool-submit" },
    { kind: "ai_chat", conversationId, automaticAfterReview: true, cardAnchor: "code-version-66666666-6666-4666-8666-666666666666" },
  ]) {
    const stored = CodeSubmissionOriginSchema.parse(raw);
    const projected = cardOrigin(stored);
    expect(schema.parse(projected)).toEqual(
      stored.kind === "cli" ? { kind: "cli" } : { kind: "ai_chat", conversationId, automaticAfterReview: stored.automaticAfterReview },
    );
    expect(projected).not.toHaveProperty("cardAnchor");
  }
});

test("missing or malformed stored origins remain CLI receipts", () => {
  for (const raw of [null, {}, { kind: "ai_chat", conversationId: "invalid", automaticAfterReview: false }])
    expect(schema.parse(cardOrigin(raw))).toEqual({ kind: "cli" });
});
