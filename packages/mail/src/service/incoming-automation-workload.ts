import { mandates } from "@k2b/cloud/services";
import { sql } from "bun";
import { hasCurrentMailboxUserPermission } from "./collaborators";

export type IncomingAutomationMandateCaller = {
  authorization: string;
  mandate: { id: string; revision: number; callingAppId: "mail" };
};

export const incomingAutomationMandateCaller = (
  mandate: { id: string; revision: number },
  credential = process.env.CLOUD_APP_CREDENTIAL,
): IncomingAutomationMandateCaller => {
  const token = credential?.trim();
  if (!token) {
    throw Object.assign(new Error("Mail workload authorization is unavailable"), { code: "WORKLOAD_AUTH_UNAVAILABLE" });
  }
  if (!Number.isSafeInteger(mandate.revision) || mandate.revision < 1) {
    throw Object.assign(new Error("This automation has no active Spaces authorization"), { code: "FORBIDDEN" });
  }
  return {
    authorization: `Bearer ${token}`,
    mandate: { id: mandate.id, revision: mandate.revision, callingAppId: "mail" },
  };
};

/**
 * Resolves the mandate an automation run acts under.
 *
 * A mandate keeps acting as the user who authorized the automation, so the
 * automation must not outlive that user's access to the mailbox. Losing it
 * pauses the mandate and fails the caller without retries.
 */
export const resolveIncomingAutomationMandateCaller = async (
  runId: string,
): Promise<IncomingAutomationMandateCaller & { requestId: string }> => {
  const [row] = await sql<
    { mailbox_id: string; mandate_id: string | null; mandate_revision: string | number | null; subject_user_id: string | null }[]
  >`
    SELECT automation.mailbox_id::text,
           automation.mandate_id,
           mandate.revision AS mandate_revision,
           mandate.subject_user_id::text
    FROM workflows.run run
    JOIN mail.incoming_automations automation ON automation.workflow_id = run.workflow_id
    LEFT JOIN auth.mandates mandate ON mandate.id = automation.mandate_id
    WHERE run.id = ${runId}::uuid
      AND automation.deleted_at IS NULL
  `;
  if (!row?.mandate_id) throw Object.assign(new Error("This automation has no active Spaces authorization"), { code: "FORBIDDEN" });
  const subjectAllowed =
    row.subject_user_id !== null &&
    (await hasCurrentMailboxUserPermission({ mailboxId: row.mailbox_id, userId: row.subject_user_id, minimumPermission: "write" }));
  if (!subjectAllowed) {
    await mandates.pause({
      mandateId: row.mandate_id,
      expectedRevision: Number(row.mandate_revision),
      authority: { kind: "workload", ownerAppId: "mail" },
    });
    throw Object.assign(new Error("The user who authorized this automation no longer has write access to this mailbox"), {
      code: "FORBIDDEN",
    });
  }
  return {
    ...incomingAutomationMandateCaller({ id: row.mandate_id, revision: Number(row.mandate_revision) }),
    requestId: runId,
  };
};
