import { sql } from "bun";
import type { ActorRef } from "../contracts";
import type { MailRequestContext } from "./auth";
import { actorRefFromRequest } from "./auth";

type SqlClient = typeof sql;

export type MailWorkflowAuthorizationSnapshot = {
  version: 2;
  authority: "mailbox";
  mailboxId: string;
  activatedBy: ActorRef;
  capturedAt: string;
};

/** Mail workflows always act as the mailbox, never as the user who authored them. */
export type MailWorkflowExecutionAuthority = { mailboxId: string; workflowVersionId: string };

export const snapshotMailboxWorkflowAuthorization = (
  context: MailRequestContext,
  mailboxId: string,
): MailWorkflowAuthorizationSnapshot => ({
  version: 2,
  authority: "mailbox",
  mailboxId,
  activatedBy: actorRefFromRequest(context),
  capturedAt: new Date().toISOString(),
});

const mailboxWorkflowAuthorized = async (mailboxId: string, workflowVersionId: string, db: SqlClient): Promise<boolean> => {
  const [row] = await db<{ authorized: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM workflows.version version
      JOIN workflows.workflow workflow
        ON workflow.id = version.workflow_id
       AND workflow.active_version_id = version.id
      JOIN mail.workflow_profile profile
        ON profile.id = workflow.id
       AND profile.enabled
      WHERE profile.mailbox_id = ${mailboxId}::uuid
        AND version.id = ${workflowVersionId}::uuid
    ) AS authorized
  `;
  return row?.authorized === true;
};

export const resolveMailWorkflowExecutionAuthority = async (params: {
  snapshot: MailWorkflowAuthorizationSnapshot;
  mailboxId: string;
  workflowVersionId: string;
  runId: string;
}): Promise<MailWorkflowExecutionAuthority | null> => {
  if (params.snapshot.mailboxId !== params.mailboxId) return null;
  return (await mailboxWorkflowAuthorized(params.mailboxId, params.workflowVersionId, sql))
    ? { mailboxId: params.mailboxId, workflowVersionId: params.workflowVersionId }
    : null;
};

export const mailWorkflowExecutionAuthorityActive = async (
  authority: MailWorkflowExecutionAuthority,
  mailboxId: string,
  workflowVersionId: string,
  db: SqlClient = sql,
): Promise<boolean> => {
  if (authority.mailboxId !== mailboxId || authority.workflowVersionId !== workflowVersionId) return false;
  return mailboxWorkflowAuthorized(mailboxId, workflowVersionId, db);
};
