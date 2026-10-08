import { sql } from "bun";
import type { MailRetention } from "../../contracts/outgoing-mail";
import { toPgUuidArray } from "../postgres";
import { get } from "../settings";
import { deleteMailObjects } from "./attachments";
import { messageAttachmentRefs } from "./messages";

/** One bounded batch, callable without starting a scheduler. */
export const retainOutgoingMailBatch = async (contentDays: number, recordDays: number) => {
  if (
    !Number.isSafeInteger(contentDays) ||
    contentDays < 1 ||
    contentDays > 36500 ||
    !Number.isSafeInteger(recordDays) ||
    recordDays < 1 ||
    recordDays > 36500
  )
    throw new RangeError("Mail content and record retention must both be whole days from 1 to 36500.");
  return sql.begin(async (tx) => {
    // Compare created_at with a constant so the created_at index bounds every batch.
    const rows = await tx<{ id: string; attachment_refs: unknown; expired: boolean }[]>`SELECT id, attachment_refs,
      created_at < now() - make_interval(days => ${recordDays}::int) AS expired
      FROM outgoing_mail.messages WHERE created_at < now() - make_interval(days => ${Math.min(contentDays, recordDays)}::int)
      AND (created_at < now() - make_interval(days => ${recordDays}::int) OR content_purged_at IS NULL)
      ORDER BY created_at LIMIT 1000 FOR UPDATE SKIP LOCKED`;
    const expired = rows.filter((row) => row.expired);
    const content = rows.filter((row) => !row.expired);
    for (const row of expired) await deleteMailObjects(messageAttachmentRefs(row));
    if (expired.length) await tx`DELETE FROM outgoing_mail.messages WHERE id = ANY(${toPgUuidArray(expired.map((row) => row.id))}::uuid[])`;
    if (content.length)
      await tx`UPDATE outgoing_mail.messages SET text_body = NULL, html_body = NULL, headers = NULL,
      content_purged_at = now(), updated_at = now() WHERE id = ANY(${toPgUuidArray(content.map((row) => row.id))}::uuid[])`;
    return { deleted: expired.length, purged: content.length };
  });
};
export const MAIL_RETENTION_KEYS = ["outgoing_mail.content_retention_days", "outgoing_mail.record_retention_days"] as const;
export const readMailRetention = async (): Promise<MailRetention> => ({
  contentDays: await get<number>(MAIL_RETENTION_KEYS[0]),
  recordDays: await get<number>(MAIL_RETENTION_KEYS[1]),
});
export const retainOutgoingMail = async (signal?: AbortSignal): Promise<void> => {
  const { contentDays, recordDays } = await readMailRetention();
  const deadline = Date.now() + 5 * 60_000;
  while (!signal?.aborted && Date.now() < deadline) {
    const result = await retainOutgoingMailBatch(contentDays, recordDays);
    if (result.deleted + result.purged < 1000) return;
  }
};
