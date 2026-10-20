import { expect, test } from "bun:test";
import type { RetentionPreviewItem } from "../../store/admin-contracts";
import { baseUpdateError, RetentionConfirmationError } from "./retention-confirmation";

const preview: RetentionPreviewItem[] = [{ kind: "raw", retention: 7, cutoff: "2026-10-10T12:00:00.000Z", rows: 1200, bytes: 48_000 }];
const previewedFrom = { rawRetentionDays: 30, rollupRetentionDays: 365, sensitiveRetentionHours: 24 };

test("a shorter retention refusal carries its preview; other refusals keep the server message", () => {
  const confirmation = baseUpdateError(409, { code: "PULSE_RETENTION_CONFIRMATION_REQUIRED", message: "Confirm", preview, previewedFrom });
  expect(confirmation).toBeInstanceOf(RetentionConfirmationError);
  expect(confirmation instanceof RetentionConfirmationError && confirmation.preview).toEqual(preview);
  expect(confirmation instanceof RetentionConfirmationError && confirmation.previewedFrom).toEqual(previewedFrom);
  // A malformed preview is never confirmed blindly: it stays an ordinary error.
  const malformed = baseUpdateError(409, {
    code: "PULSE_RETENTION_CONFIRMATION_REQUIRED",
    message: "Confirm",
    preview: [{ kind: "raw" }],
    previewedFrom,
  });
  expect(malformed).not.toBeInstanceOf(RetentionConfirmationError);
  expect(baseUpdateError(400, { code: "BAD_INPUT", message: "Raw retention must be between 1 and 730 days" }).message).toBe(
    "Raw retention must be between 1 and 730 days",
  );
  expect(baseUpdateError(500, null).message).toBe("Request failed");
});

test("a confirmation requires the previewed retention; a stale confirmation remains an ordinary retryable error", () => {
  for (const from of [undefined, null, { rawRetentionDays: 30 }, { ...previewedFrom, sensitiveRetentionHours: "24" }]) {
    const error = baseUpdateError(409, { code: "PULSE_RETENTION_CONFIRMATION_REQUIRED", message: "Confirm", preview, previewedFrom: from });
    expect(error).not.toBeInstanceOf(RetentionConfirmationError);
  }
  const error = baseUpdateError(409, { code: "PULSE_BASE_CHANGED", message: "Review the preview again." });
  expect(error).not.toBeInstanceOf(RetentionConfirmationError);
  expect(error.message).toBe("Review the preview again.");
});
