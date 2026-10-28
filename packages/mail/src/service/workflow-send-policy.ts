import type { WorkflowBoundPlan } from "@k2b/cloud/workflows";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { sql } from "bun";
import { MAIL_WORKFLOW_SEND_REVIEW_MESSAGE, mailWorkflowNeedsSendReview } from "../workflows/send-policy";

/** Publication checks do not cover versions and outbox work saved before an upgrade. */
export const authorizeMailWorkflowSend = async (params: {
  db: typeof sql;
  mailboxId: string;
  workflowVersionId: string | null;
}): Promise<Result<void>> => {
  const [version] = await params.db<{ plan: WorkflowBoundPlan | string }[]>`
    SELECT version.plan FROM workflows.version version
    JOIN mail.workflow_profile profile ON profile.id = version.workflow_id
    WHERE version.id = ${params.workflowVersionId}::uuid AND profile.mailbox_id = ${params.mailboxId}::uuid
  `;
  if (!version) return fail(err.forbidden("Workflow send authority is no longer available"));
  try {
    const plan = typeof version.plan === "string" ? JSON.parse(version.plan) : version.plan;
    if (!Array.isArray(plan.steps) || !Array.isArray(plan.inputs)) return fail(err.forbidden("Workflow send plan is invalid"));
    if (mailWorkflowNeedsSendReview(plan.steps, plan.inputs)) {
      return fail({ code: "MAIL_WORKFLOW_SEND_REVIEW_REQUIRED", message: MAIL_WORKFLOW_SEND_REVIEW_MESSAGE, status: 409 });
    }
    return ok(undefined);
  } catch {
    return fail(err.forbidden("Workflow send plan is invalid"));
  }
};
