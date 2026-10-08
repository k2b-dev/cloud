import { sql } from "bun";
import {
  type AdminMailFilter,
  type AdminMailRecord,
  AdminMailRecordSchema,
  type MailPage,
  type MailPageParams,
} from "../../contracts/outgoing-mail";
import { audit } from "../audit";
import { cleanupMailAttachments, publishMailSettled } from "./dispatcher";
import { adminMessageRecord, type MessageRow, outgoingMailMessages } from "./messages";
import { type MailAuditContext, OutgoingMailError } from "./store";

const get = async (id: string): Promise<AdminMailRecord> => {
  const record = await outgoingMailMessages.metadata(id);
  if (!record) throw new OutgoingMailError("message_unknown", "Outgoing mail message does not exist.", 404);
  return record;
};
const cancel = async (id: string, context: MailAuditContext): Promise<AdminMailRecord> => {
  const row = await sql.begin(async (tx) => {
    const [row] = await tx<MessageRow[]>`UPDATE outgoing_mail.messages SET status = 'cancelled', error_code = 'cancelled_by_admin',
      error_message = 'Cancelled by an administrator.', next_attempt_at = NULL, updated_at = now() WHERE id = ${id}::uuid AND status = 'queued'
      RETURNING *, created_at::text AS cursor_created_at`;
    if (!row) {
      if (!(await outgoingMailMessages.read(id, undefined, tx)))
        throw new OutgoingMailError("message_unknown", "Outgoing mail message does not exist.", 404);
      throw new OutgoingMailError("message_not_queued", "Only queued outgoing mail can be cancelled.", 409);
    }
    await audit.record(
      {
        ...context,
        action: "outgoing_mail.message.cancel",
        outcome: "allowed",
        target: { type: "outgoing_mail_message", id },
        metadata: { appId: row.app_id, profile: row.profile_key },
      },
      tx,
    );
    return row;
  });
  await cleanupMailAttachments(id).catch(() => {});
  await publishMailSettled(id).catch(() => {});
  return adminMessageRecord(row);
};
export const outgoingMailLog = {
  get,
  cancel,
  async cancelBatch(batchId: string, context: MailAuditContext): Promise<{ batchId: string; cancelled: number }> {
    const cancelled = await sql.begin(async (tx) => {
      const apps = await tx<{ app_id: string }[]>`SELECT DISTINCT app_id FROM outgoing_mail.messages WHERE batch_id = ${batchId}::uuid`;
      if (!apps.length) throw new OutgoingMailError("batch_unknown", "Outgoing mail batch does not exist.", 404);
      const rows = await tx<{ id: string }[]>`UPDATE outgoing_mail.messages SET status = 'cancelled', error_code = 'cancelled_by_admin',
        error_message = 'Cancelled by an administrator.', next_attempt_at = NULL, updated_at = now()
        WHERE batch_id = ${batchId}::uuid AND status = 'queued' RETURNING id`;
      await audit.record(
        {
          ...context,
          action: "outgoing_mail.batch.cancel",
          outcome: "allowed",
          target: { type: "outgoing_mail_batch", id: batchId },
          metadata: { appIds: apps.map((row) => row.app_id), count: rows.length },
        },
        tx,
      );
      return rows;
    });
    for (const row of cancelled) {
      await cleanupMailAttachments(row.id).catch(() => {});
      await publishMailSettled(row.id).catch(() => {});
    }
    return { batchId, cancelled: cancelled.length };
  },
  content: outgoingMailMessages.content,
  list: async (filter: AdminMailFilter, page: MailPageParams): Promise<MailPage<AdminMailRecord>> => {
    const result = await outgoingMailMessages.list(filter, page, true);
    return {
      ...result,
      items: result.items.map((item) => {
        // The metadata mapper deliberately omits content; validate its public boundary.
        return AdminMailRecordSchema.parse(item);
      }),
    };
  },
};
