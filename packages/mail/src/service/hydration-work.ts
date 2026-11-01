import { randomUUID } from "node:crypto";
import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";

const log = logger("mail:hydration");

/** One current generation and one merged trailing request per mailbox, including across restarts. */
export type MailboxHydrationWork = { mailbox_id: string; job_id: string };

export const requestMailboxHydration = async (db: typeof sql, mailboxId: string, retry = false): Promise<MailboxHydrationWork> => {
  const [work] = await db<MailboxHydrationWork[]>`
    INSERT INTO mail.hydration_work (mailbox_id, job_id, queued_at, retry_requested)
    VALUES (${mailboxId}::uuid, ${randomUUID()}::uuid, clock_timestamp(), ${retry})
    ON CONFLICT (mailbox_id) DO UPDATE SET
      job_id = COALESCE(hydration_work.job_id, EXCLUDED.job_id),
      queued_at = COALESCE(hydration_work.queued_at, EXCLUDED.queued_at),
      published_at = NULL,
      retry_requested = hydration_work.retry_requested OR EXCLUDED.retry_requested,
      requested_again_at = CASE WHEN hydration_work.job_id IS NULL THEN NULL
        ELSE COALESCE(hydration_work.requested_again_at, EXCLUDED.queued_at) END
    RETURNING mailbox_id, job_id
  `;
  if (!work) throw new Error("Mailbox hydration request returned no generation");
  return work;
};

/** Clear covered requests before reading bodies, never after the final pending-body query. */
export const beginMailboxHydration = async (work: MailboxHydrationWork, deliveryId: string): Promise<{ retryBodies: boolean } | null> => {
  const [row] = await sql<{ retry_bodies: boolean }[]>`
    UPDATE mail.hydration_work SET
      delivery_id = ${deliveryId},
      started_at = COALESCE(started_at, clock_timestamp()),
      retry_bodies = retry_bodies OR retry_requested,
      retry_requested = false,
      requested_again_at = NULL
    WHERE mailbox_id = ${work.mailbox_id}::uuid AND job_id = ${work.job_id}::uuid
    RETURNING retry_bodies
  `;
  return row ? { retryBodies: row.retry_bodies } : null;
};

/**
 * A producer and completion serialize on this row. A request before completion makes a new
 * generation; one after completion starts its own. Neither can join the retiring NATS key.
 */
export const finishMailboxHydration = async (work: MailboxHydrationWork, more: boolean, deliveryId: string): Promise<void> => {
  await sql`
    UPDATE mail.hydration_work SET
      job_id = CASE WHEN requested_again_at IS NOT NULL OR ${more} THEN ${randomUUID()}::uuid ELSE NULL END,
      queued_at = CASE WHEN requested_again_at IS NOT NULL OR ${more} THEN COALESCE(requested_again_at, clock_timestamp()) ELSE NULL END,
      requested_again_at = NULL,
      retry_bodies = false,
      delivery_id = NULL,
      started_at = NULL,
      published_at = NULL
    WHERE mailbox_id = ${work.mailbox_id}::uuid AND job_id = ${work.job_id}::uuid AND delivery_id = ${deliveryId}
  `;
};

/** Bounded outbox pass. Failed publication leaves the generation due for the next pass. */
export const publishPendingHydrationWork = async (
  publish: (work: MailboxHydrationWork) => Promise<unknown>,
  mailboxId?: string,
  stopped: () => boolean = () => false,
): Promise<void> => {
  const pending = await sql<MailboxHydrationWork[]>`
    SELECT mailbox_id, job_id FROM mail.hydration_work
    WHERE job_id IS NOT NULL AND published_at IS NULL
      AND (${mailboxId ?? null}::uuid IS NULL OR mailbox_id = ${mailboxId ?? null}::uuid)
    ORDER BY queued_at, mailbox_id LIMIT 500
  `;
  let failed = 0;
  for (const work of pending) {
    if (stopped()) break;
    try {
      await publish(work);
      await sql`
        UPDATE mail.hydration_work SET published_at = clock_timestamp()
        WHERE mailbox_id = ${work.mailbox_id}::uuid AND job_id = ${work.job_id}::uuid
      `;
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) log.warn("Mail hydration generation publication failed; retrying", { mailboxes: failed });
};

export const recordHydrationBatchTime = async (mailboxId: string, batchMs: number): Promise<void> => {
  await sql`
    UPDATE mail.hydration_work SET batch_ms = ${Math.max(0, Math.round(batchMs))}, batch_finished_at = clock_timestamp()
    WHERE mailbox_id = ${mailboxId}::uuid
  `;
};

export const recordHydrationLeaseWait = async (work: MailboxHydrationWork): Promise<void> => {
  await sql`
    UPDATE mail.hydration_work SET
      queue_wait_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (started_at - queued_at)) * 1000))::bigint,
      lease_wait_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - started_at)) * 1000))::bigint
    WHERE mailbox_id = ${work.mailbox_id}::uuid AND job_id = ${work.job_id}::uuid
  `;
};
