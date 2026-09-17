import { expect, test } from "bun:test";
import { apiMessagesForLocale } from "../api/messages";
import { type BackgroundFailureContext, backgroundFailureMessage } from "./background-failure";

const context: BackgroundFailureContext = {
  principal: { userId: "owner", serviceAccountId: null, actorServiceAccountId: null, groupIds: [], credential: null },
  messages: apiMessagesForLocale("de"),
};
const run = {
  state: "failed" as const,
  user_id: "owner",
  service_account_id: null,
  actor_service_account_id: null,
  error_code: "WORKFLOW_FAILED",
  error_message: "Bitte die IBAN prüfen. 00000000-0000-4000-8000-000000000001",
};

test("background authored failures are sanitized and scoped to the invoking principal", () => {
  expect(backgroundFailureMessage(run, context)).toBe("Bitte die IBAN prüfen. …");
  expect(backgroundFailureMessage(run)).toBeUndefined();
  expect(backgroundFailureMessage({ ...run, user_id: "other" }, context)).toBeUndefined();
  expect(backgroundFailureMessage({ ...run, actor_service_account_id: "different delegate" }, context)).toBeUndefined();
  expect(backgroundFailureMessage({ ...run, service_account_id: "another account" }, context)).toBeUndefined();
});

test("background runtime failures and uncertain outcomes never expose private diagnostics", () => {
  expect(backgroundFailureMessage({ ...run, error_code: "WORKFLOW_ACTION_ERROR" }, context)).toBe(context.messages.workflowStatusFailed);
  expect(backgroundFailureMessage({ ...run, state: "needs_attention" }, context)).toBe(context.messages.workflowStatusNeedsAttention);
  expect(backgroundFailureMessage({ ...run, state: "running" }, context)).toBeUndefined();
});
