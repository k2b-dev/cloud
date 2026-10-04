import { coreSettings, logger, notifications } from "@k2b/cloud/services";
import { sql } from "bun";
import { app } from "../config";

const log = logger("mail:send-login-notifications");

/**
 * Tells the person who sent a message that it waits for its mailbox's next login, or that it went
 * back to the drafts because the login did not come in time. Each notice goes out once per send.
 * Called after the send's state committed; a lost notice never changes the send.
 */
export const notifySendWaitingForLogin = async (params: { outboxId: string; notice: "waiting" | "returned" }): Promise<void> => {
  try {
    const [send] = await sql<
      { recipient_user_id: string; mailbox_short_id: string; mailbox_name: string; subject: string | null; scheduled: boolean }[]
    >`
      SELECT
        command.access_subject_id AS recipient_user_id,
        mailbox.short_id AS mailbox_short_id,
        mailbox.name AS mailbox_name,
        outbox.draft_snapshot ->> 'subject' AS subject,
        command.payload ->> 'scheduledAt' IS NOT NULL AS scheduled
      FROM mail.outbox_submissions outbox
      JOIN mail.commands command ON command.id = outbox.command_id
      JOIN mail.mailboxes mailbox ON mailbox.id = outbox.mailbox_id
      WHERE outbox.id = ${params.outboxId}::uuid
        AND command.access_subject_kind = 'user'
    `;
    // Workflows and service accounts have nobody to tell.
    if (!send) return;
    await notifications.send(app.notifications.sendWaitingForLogin, {
      recipient: { userId: send.recipient_user_id },
      data: {
        mailboxId: send.mailbox_short_id,
        mailboxName: send.mailbox_name,
        subject: send.subject ?? "",
        scheduled: send.scheduled,
        notice: params.notice,
      },
      idempotencyKey: `send-login:${params.notice}:${params.outboxId}`,
      locale: (await coreSettings.get<string>("app.locale")) || undefined,
    });
  } catch (error) {
    log.warn("Failed to send a Mail login wait notification", {
      outboxId: params.outboxId,
      notice: params.notice,
      error: error instanceof Error ? error.message : "Notification send failed",
    });
  }
};
