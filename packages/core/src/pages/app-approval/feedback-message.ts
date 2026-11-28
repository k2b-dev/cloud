import { ApprovalError } from "./client";
import type { appApprovalMessages } from "./messages";

type Messages = ReturnType<(typeof appApprovalMessages)["resolve"]>["t"];

/** The approval step needs a recent sign-in: the error says so, or the server answered 401. */
export const isRecentSignInRequired = (error: unknown): boolean =>
  error instanceof ApprovalError && (error.code === "REAUTHENTICATE" || error.status === 401);

/** A failed app approval in words, the same on v1 (`ApprovalFeedback`) and v2 (`ApprovalFeedbackV2`). */
export const approvalErrorMessage = (error: unknown, t: Messages): string => {
  if (isRecentSignInRequired(error)) return t.recent;
  const code = error instanceof ApprovalError ? error.code : "UNKNOWN";
  return code === "ACCOUNT_MISMATCH"
    ? t.accountMismatch
    : code === "FORBIDDEN"
      ? t.forbidden
      : code === "CONFLICT"
        ? t.conflict
        : code === "LIMIT_REACHED"
          ? t.limit
          : code === "UNAVAILABLE"
            ? t.unavailable
            : t.failure;
};
