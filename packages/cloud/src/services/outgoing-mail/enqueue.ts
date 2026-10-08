import { type SQL, sql } from "bun";
import type { MailMessage } from "../../contracts/outgoing-mail";
import {
  cancelMailStreams,
  deleteMailObjects,
  MAIL_ATTACHMENT_UPLOAD_MS,
  type UploadedAttachments,
  uploadMailAttachments,
} from "./attachments";
import { mailBacklogFull, mailBatchId } from "./bulk";
import {
  type AcceptedProfile,
  allowedMailProfile,
  insertMailMessage,
  type MailAcceptanceOptions,
  MailQuotaError,
  type MessageRow,
  mailQuotaUsed,
  outgoingMailMessages,
  recordMailBatch,
} from "./messages";
import { OutgoingMailError } from "./store";
import { mailAttachments, mailDrainJob, mailSettled, submitMailDrain } from "./sync";

type BatchItem = { id: string; message: MailMessage; existing?: MessageRow; uploaded: UploadedAttachments };
type AcceptedBatch = { batchId: string; rows: MessageRow[]; created: MessageRow[] };
const lockBatchApp = async (db: SQL, appId: string) => {
  // One app lock serializes batches with batches and keyed sends without per-key locks.
  // Lock order: policy -> app -> key (send only) -> quota -> backlog -> call.
  await db`SELECT pg_advisory_xact_lock_shared(hashtextextended('outgoing_mail.policy', 0))`;
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${appId}, 5))`;
};
/** Retain uploads when a lost COMMIT response cannot be resolved by a recovery read. */
export class MailAcceptanceUnknown extends OutgoingMailError {
  constructor() {
    super("mail_unavailable", "Outgoing mail acceptance could not be determined. Retry with the same keys.", 502);
  }
}
const checkBatch = async (db: SQL, appId: string, items: readonly BatchItem[]) => {
  const profiles = new Map<string, AcceptedProfile>();
  // Stable order for batches that request multiple profiles.
  for (const key of [...new Set(items.map((item) => item.message.profile))].sort())
    profiles.set(key ?? "", await allowedMailProfile(db, appId, key));
  const totals = new Map<string, { profile: AcceptedProfile; recipients: number; count: number }>();
  for (const item of items) {
    const profile = profiles.get(item.message.profile ?? "")!;
    if (item.uploaded.metadata.reduce((sum, attachment) => sum + attachment.size, 0) > profile.max_attachment_bytes)
      throw new OutgoingMailError("attachments_too_large", "Attachments exceed the profile's total byte limit.");
    const total = totals.get(profile.id) ?? { profile, recipients: 0, count: 0 };
    total.recipients += item.message.to.length;
    total.count++;
    totals.set(profile.id, total);
  }
  for (const id of [...totals.keys()].sort()) {
    const { profile, recipients, count } = totals.get(id)!;
    // Same quota lock as immediate acceptance, plus a profile-wide backlog lock across apps.
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([appId, id])}, 2))`;
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 3))`;
    const used = await mailQuotaUsed(db, appId, id);
    if (profile.daily_recipient_limit !== null && used + recipients > profile.daily_recipient_limit)
      throw new MailQuotaError(profile.daily_recipient_limit, used, recipients);
    const [backlog] = await db<{ queued: number }[]>`SELECT count(*)::int AS queued FROM outgoing_mail.messages
      WHERE profile_id = ${id}::uuid AND lane = 'bulk' AND status = 'queued'`;
    if (mailBacklogFull(backlog?.queued ?? 0, count, profile.pace_per_minute))
      throw new OutgoingMailError("backlog_full", "The profile's bulk queue exceeds 24 hours of delivery capacity.", 409);
  }
  return profiles;
};
export const outgoingMailBatches = {
  async accept(appId: string, proposed: string, items: readonly BatchItem[], options?: MailAcceptanceOptions): Promise<AcceptedBatch> {
    let result: AcceptedBatch | undefined;
    try {
      return await sql.begin(async (tx) => {
        await lockBatchApp(tx, appId);
        const known: (MessageRow | undefined)[] = [];
        for (const item of items) known.push(await outgoingMailMessages.known(appId, item.message.key, tx));
        const fresh = items.filter((_, index) => !known[index]);
        if (fresh.some((item) => item.existing))
          throw new OutgoingMailError(
            "mail_unavailable",
            "An idempotent mail record expired during acceptance. Retry with fresh attachments.",
          );
        const profiles = await checkBatch(tx, appId, fresh);
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${proposed}, 4))`;
        let batchId = mailBatchId(proposed, known);
        const rows: MessageRow[] = [];
        const created: MessageRow[] = [];
        for (const [index, item] of items.entries()) {
          let row = known[index];
          if (!row) {
            row = await insertMailMessage(
              tx,
              appId,
              item.id,
              item.message,
              item.uploaded,
              profiles.get(item.message.profile ?? "")!,
              batchId,
              options,
            );
            if (row) created.push(row);
            else row = await outgoingMailMessages.known(appId, item.message.key, tx);
          }
          if (!row) throw new Error("Outgoing mail batch insert returned no row");
          rows.push(row);
        }
        if (!created.length) batchId = mailBatchId(proposed, rows);
        await recordMailBatch(
          appId,
          items.map((item) => item.message),
          rows,
          batchId,
          tx,
        );
        result = { batchId, rows, created };
        return result;
      });
    } catch (error) {
      if (result?.created.length) {
        // A callback completed but COMMIT may have lost its response. The call lock
        // waits for that transaction to finish before deciding whether it recorded rows.
        try {
          const committed = await sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${proposed}, 4))`;
            return !!(await outgoingMailMessages.read(result!.created[0]!.id, appId, tx));
          });
          if (committed) return result;
        } catch {
          throw new MailAcceptanceUnknown();
        }
      }
      throw error;
    }
  },
};
export const enqueueMail = async (
  appId: string,
  messages: readonly MailMessage[],
  options?: MailAcceptanceOptions,
): Promise<{ batchId: string; ids: string[] }> => {
  const items: BatchItem[] = [];
  try {
    for (const message of messages) {
      items.push({ id: crypto.randomUUID(), message, uploaded: { metadata: [], refs: [] } });
    }
    const profiles = await sql.begin(async (tx) => {
      await lockBatchApp(tx, appId);
      for (const item of items) {
        item.existing = await outgoingMailMessages.known(appId, item.message.key, tx);
        if (item.existing) cancelMailStreams(item.message.attachments);
      }
      return checkBatch(
        tx,
        appId,
        items.filter((item) => !item.existing),
      );
    });
    const fresh = items.filter((item) => !item.existing);
    if (fresh.length) await Promise.all([mailDrainJob().ready(), mailSettled().ready(), mailAttachments().ready()]);
    const deadline = Date.now() + MAIL_ATTACHMENT_UPLOAD_MS;
    for (const item of fresh)
      item.uploaded = await uploadMailAttachments(
        item.id,
        item.message.attachments ?? [],
        profiles.get(item.message.profile ?? "")!.max_attachment_bytes,
        deadline,
      );
    const accepted = await outgoingMailBatches.accept(appId, crypto.randomUUID(), items, options);
    const createdIds = new Set(accepted.created.map((row) => row.id));
    for (const item of items) if (!createdIds.has(item.id)) await deleteMailObjects(item.uploaded.refs).catch(() => {});
    for (const id of new Set(accepted.created.flatMap((row) => (row.profile_id ? [row.profile_id] : []))))
      void submitMailDrain(id).catch(() => {});
    return { batchId: accepted.batchId, ids: accepted.rows.map((row) => row.id) };
  } catch (error) {
    for (const message of messages) cancelMailStreams(message.attachments);
    // Only an indeterminate COMMIT retains objects for the 48-hour expiry.
    if (!(error instanceof MailAcceptanceUnknown)) for (const item of items) await deleteMailObjects(item.uploaded.refs).catch(() => {});
    throw error;
  }
};
