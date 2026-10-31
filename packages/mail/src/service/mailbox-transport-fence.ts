import { sql } from "@k2b/cloud";

type SqlClient = typeof sql;

export type MailboxTransportFence = {
  remoteResourceId: string;
  generation: number;
};

export const loadMailboxTransportFence = async (remoteResourceId: string, db: SqlClient = sql): Promise<MailboxTransportFence | null> => {
  const [row] = await db<{ generation: string | number }[]>`
    SELECT resource.sync_generation AS generation
    FROM mail.remote_resources resource
    JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
    WHERE resource.id = ${remoteResourceId}::uuid
      AND resource.status = 'active'
      AND mailbox.sync_enabled = true
      AND mailbox.deleted_at IS NULL
  `;
  return row ? { remoteResourceId, generation: Number(row.generation) } : null;
};

export const assertMailboxTransportFence = async (fence: MailboxTransportFence, db: SqlClient = sql): Promise<void> => {
  const [row] = await db<{ id: string }[]>`
    SELECT resource.id
    FROM mail.remote_resources resource
    JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
    WHERE resource.id = ${fence.remoteResourceId}::uuid
      AND resource.sync_generation = ${fence.generation}
      AND resource.status = 'active'
      AND mailbox.sync_enabled = true
      AND mailbox.deleted_at IS NULL
    FOR SHARE OF resource, mailbox
  `;
  if (!row) {
    throw Object.assign(new Error("Mailbox transport changed during provider work"), {
      code: "MAILBOX_TRANSPORT_CHANGED",
    });
  }
};
