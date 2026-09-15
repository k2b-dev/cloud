import { expect, test } from "bun:test";
import { apiMessagesForLocale, gridsApiMessages } from "../api/messages";
import { customAppWorkflowStatusMessage } from "./workflow-status-message";

for (const locale of ["en", "de"]) {
  const messages = apiMessagesForLocale(locale);

  test(`published actions preserve exact authored failures (${locale})`, () => {
    for (const code of ["WORKFLOW_FAILED", "ATOMIC_CHECK_FAILED", "DOCUMENT_INPUT_INVALID"]) {
      expect(
        customAppWorkflowStatusMessage(
          {
            status: "failed",
            resultMessage: null,
            error: { code, message: "Bitte die IBAN prüfen.", retryable: false },
          },
          messages,
        ),
      ).toBe("Bitte die IBAN prüfen.");
    }
  });

  test(`published actions provide safe recovery without exposing diagnostics (${locale})`, () => {
    const expected = {
      BAD_INPUT: messages.workflowStatusValidationFailed,
      CONFLICT: messages.workflowStatusStateChanged,
      ATOMIC_LOCK_UNAVAILABLE: messages.workflowStatusStateChanged,
      FORBIDDEN: messages.workflowStatusAuthorizationChanged,
      WORKFLOW_ACTION_ERROR: messages.workflowStatusFailed,
      DOCUMENT_RENDER_FAILED: messages.workflowStatusFailed,
      DOCUMENT_TEMPLATE_INVALID: messages.workflowStatusFailed,
      DOCUMENT_PROFILE_REQUIRED: messages.workflowStatusFailed,
      DOCUMENT_PROFILE_INVALID: messages.workflowStatusFailed,
      "40001": messages.workflowStatusFailed,
      UNKNOWN: messages.workflowStatusFailed,
    };
    for (const [code, safeMessage] of Object.entries(expected)) {
      const message = customAppWorkflowStatusMessage(
        {
          status: "failed",
          resultMessage: "private result",
          error: { code, message: "private SQL, renderer or validation details", retryable: false },
        },
        messages,
      );
      expect(message).toBe(safeMessage);
      expect(message).not.toContain("private");
    }
    expect(customAppWorkflowStatusMessage({ status: "failed", resultMessage: null, error: null }, messages)).toBe(
      messages.workflowStatusFailed,
    );
  });

  test(`status distinctions do not expose stale or uncertain errors (${locale})`, () => {
    const error = { code: "WORKFLOW_FAILED", message: "private stale details", retryable: false };
    for (const status of ["queued", "running", "waiting"] as const)
      expect(customAppWorkflowStatusMessage({ status, resultMessage: "not terminal", error }, messages)).toBeNull();
    for (const status of ["succeeded", "canceled"] as const) {
      expect(customAppWorkflowStatusMessage({ status, resultMessage: "Authored result", error }, messages)).toBe("Authored result");
      expect(customAppWorkflowStatusMessage({ status, resultMessage: null, error }, messages)).toBe(
        status === "canceled" ? messages.workflowStatusCanceled : null,
      );
    }
    expect(customAppWorkflowStatusMessage({ status: "needs_attention", resultMessage: "private result", error }, messages)).toBe(
      messages.workflowStatusNeedsAttention,
    );
  });
}

test("safe messages follow each request locale and have complete translations", () => {
  const run = { status: "failed" as const, resultMessage: null, error: { code: "BAD_INPUT", message: "private", retryable: false } };
  const english = customAppWorkflowStatusMessage(run, apiMessagesForLocale("en"));
  const german = customAppWorkflowStatusMessage(run, apiMessagesForLocale("de-DE"));
  expect(english).toContain("Review the saved values");
  expect(german).toContain("Prüfe die gespeicherten Werte");
  expect(customAppWorkflowStatusMessage(run, apiMessagesForLocale("en"))).toBe(english);
  expect(gridsApiMessages.check()).toEqual([]);
});
