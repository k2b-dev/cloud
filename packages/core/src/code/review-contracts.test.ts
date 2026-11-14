import { expect, test } from "bun:test";
import { APPROVAL_MAX_WAIT_MS } from "@k2b/cloud/services/approvals";
import {
  CODE_REVIEW_COMMENT_LENGTH,
  CODE_REVIEW_COMMENT_LIMIT,
  CODE_REVIEW_MAX_WAIT_MS,
  CodeReviewDecisionSchema,
  codeReviewCommentContracts,
} from "./review-contracts";

test("three domain outcomes keep negative decisions textual and bounded", () => {
  expect(CodeReviewDecisionSchema.safeParse({ outcome: "approved" }).success).toBe(true);
  for (const outcome of ["rejected", "changes_requested"]) {
    expect(CodeReviewDecisionSchema.safeParse({ outcome }).success).toBe(false);
    expect(CodeReviewDecisionSchema.safeParse({ outcome, comment: " \n " }).success).toBe(false);
    expect(CodeReviewDecisionSchema.safeParse({ outcome, comment: "Explain this access." }).success).toBe(true);
    expect(CodeReviewDecisionSchema.safeParse({ outcome, comment: "x".repeat(CODE_REVIEW_COMMENT_LENGTH + 1) }).success).toBe(false);
  }
  expect(CODE_REVIEW_MAX_WAIT_MS).toBe(APPROVAL_MAX_WAIT_MS * 14);
  expect(CODE_REVIEW_COMMENT_LIMIT).toBeGreaterThan(0);
});
test("comment paths, anchors and pagination are bounded at the transport", () => {
  const valid = { codeId: "c_review", versionId: "11111111-1111-4111-8111-111111111111", path: "code.ts", line: 1, body: "Change this." };
  expect(codeReviewCommentContracts.create.input.safeParse(valid).success).toBe(true);
  for (const change of [{ path: "../code.ts" }, { line: 0 }, { body: " " }, { body: "x".repeat(5001) }])
    expect(codeReviewCommentContracts.create.input.safeParse({ ...valid, ...change }).success).toBe(false);
  expect(codeReviewCommentContracts.list.input.safeParse({ codeId: valid.codeId, versionId: valid.versionId, limit: 51 }).success).toBe(
    false,
  );
});
