import type { GridsApiMessages } from "../api/messages";
import { publicDiagnosticMessage } from "../service/public-diagnostics";
import type { GridsWorkflowRun } from "../workflows/contracts";

type StatusMessages = Pick<
  GridsApiMessages,
  | "workflowStatusValidationFailed"
  | "workflowStatusStateChanged"
  | "workflowStatusAuthorizationChanged"
  | "workflowStatusNeedsAttention"
  | "workflowStatusFailed"
  | "workflowStatusCanceled"
>;

/** Only deliberate authored failures expose their original message.
 * Driver, renderer and validation diagnostics can contain private internals.
 * A failed run does not imply earlier successful steps were rolled back.
 */
export const customAppWorkflowStatusMessage = (
  run: Pick<GridsWorkflowRun, "status" | "resultMessage" | "error">,
  messages: StatusMessages,
): string | null => {
  if (run.status === "succeeded") return run.resultMessage;
  if (run.status === "canceled") return run.resultMessage ?? messages.workflowStatusCanceled;
  if (run.status === "needs_attention") return messages.workflowStatusNeedsAttention;
  if (run.status !== "failed") return null;
  switch (run.error?.code) {
    case "WORKFLOW_FAILED":
    case "ATOMIC_CHECK_FAILED":
    case "DOCUMENT_INPUT_INVALID":
      return publicDiagnosticMessage(run.error.message);
    // Finalization readiness and profile input validation use ServiceError codes.
    case "BAD_INPUT":
      return messages.workflowStatusValidationFailed;
    case "CONFLICT":
    case "ATOMIC_LOCK_UNAVAILABLE":
      return messages.workflowStatusStateChanged;
    case "FORBIDDEN":
      return messages.workflowStatusAuthorizationChanged;
    default:
      return messages.workflowStatusFailed;
  }
};
