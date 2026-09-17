import type { GridsWorkflowPrincipal, GridsWorkflowRun } from "../workflows/contracts";
import { customAppWorkflowStatusMessage } from "./workflow-status-message";

export type BackgroundFailureContext = {
  principal: GridsWorkflowPrincipal;
  messages: Parameters<typeof customAppWorkflowStatusMessage>[1];
};

/** Shared record status is public to app readers; authored failures remain actor-scoped. */
export function backgroundFailureMessage(
  run: {
    state: GridsWorkflowRun["status"];
    user_id: string | null;
    service_account_id: string | null;
    actor_service_account_id: string | null;
    error_code: string | null;
    error_message: string | null;
  },
  context?: BackgroundFailureContext,
): string | undefined {
  if (!context || !["failed", "needs_attention", "canceled"].includes(run.state)) return undefined;
  const principal = context.principal;
  if (
    (!principal.userId && !principal.serviceAccountId) ||
    run.user_id !== principal.userId ||
    run.service_account_id !== principal.serviceAccountId ||
    run.actor_service_account_id !== (principal.actorServiceAccountId ?? null)
  )
    return undefined;
  return (
    customAppWorkflowStatusMessage(
      {
        status: run.state,
        resultMessage: null,
        error: run.error_code && run.error_message ? { code: run.error_code, message: run.error_message, retryable: false } : null,
      },
      context.messages,
    ) ?? undefined
  );
}
