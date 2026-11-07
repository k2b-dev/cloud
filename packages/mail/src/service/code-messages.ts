import { sql } from "@k2b/cloud";
import { CODE_EVENT_CATCHUP_LIMIT, type CodeTestMock } from "@k2b/cloud/code";
import type { CapabilityExecutionContext, CapabilityResult } from "@k2b/cloud/contracts";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { z } from "zod";
import type { MessageDataSchema } from "../capability-contracts";
import { MailCodeSelectionInputSchema } from "../mail-code-contracts";
import { requireMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { resolveMailboxPublicId, resolvePublicId } from "./public-resources";
import { message as messageMailbox } from "./resource-parents";

type Row = {
  id: string;
  short_id: string;
  mailbox: string;
  subject: string;
  internal_date: string;
  receipt_id: string;
  first_seen_at: string;
  mailbox_id: string;
};
/** Historical references only: choosing mail never sends an event or runs Code. */
export const mailCodeEvent = (row: Row) => ({
  id: row.receipt_id,
  type: "mail.message.received",
  version: 1,
  source: "mail",
  time: new Date(row.first_seen_at).toISOString(),
  subject: { type: "mail.message", id: row.short_id },
  place: { type: "mail.mailbox", id: row.mailbox },
  data: { receiptId: row.receipt_id },
});
const requestContext = (context: CapabilityExecutionContext): MailRequestContext => ({
  actor: context.actor,
  accessSubject: context.accessSubject,
  requestId: context.requestId,
});

export async function selectMailCodeMessages(
  mailboxShortId: string,
  raw: z.infer<typeof MailCodeSelectionInputSchema>,
  context: CapabilityExecutionContext,
) {
  const input = MailCodeSelectionInputSchema.parse(raw);
  const mailbox = await resolvePublicId("mailboxes", mailboxShortId);
  if (!mailbox) return fail(err.notFound("Mailbox"));
  const allowed = await requireMailboxAccess(requestContext(context), mailbox, "read");
  if (!allowed.ok) return fail(err.notFound("Mailbox"));
  // Code editors may have a share without mailbox administration. Selection still requires whole-mailbox read access.
  if (allowed.data.scope !== "mailbox") return fail(err.forbidden("Whole-mailbox read access required"));
  const folder = input.folderId ? await resolveMailboxPublicId("folders", mailbox, input.folderId) : null;
  if (input.folderId && !folder) return fail(err.notFound("Folder"));
  const cutoffAt = input.cutoffAt ?? new Date().toISOString();
  const rows = await sql<Row[]>`
    SELECT message.id,message.short_id,message.mailbox_id,box.short_id AS mailbox,message.subject,message.internal_date,
      receipt.receipt_id,receipt.first_seen_at
    FROM mail.message_contents message JOIN mail.mailboxes box ON box.id=message.mailbox_id
    JOIN LATERAL (
      SELECT ref.id AS receipt_id,ref.first_seen_at
      FROM mail.remote_message_refs ref JOIN mail.folders folder ON folder.id=ref.folder_id
      JOIN mail.message_placements placement ON placement.remote_message_ref_id=ref.id
      WHERE ref.message_id=message.id AND ref.stale_at IS NULL AND placement.deleted_at IS NULL
        AND folder.role NOT IN ('trash','junk','sent','drafts','all')
        AND (${folder}::uuid IS NULL OR folder.id=${folder}::uuid)
        AND ref.first_seen_at<=${cutoffAt}::timestamptz
      ORDER BY ref.first_seen_at,ref.id LIMIT 1
    ) receipt ON true
    WHERE message.mailbox_id=${mailbox}::uuid AND message.created_at<=${cutoffAt}::timestamptz
      AND (${input.from ?? null}::timestamptz IS NULL OR message.internal_date>=${input.from ?? null}::timestamptz)
      AND (${input.to ?? null}::timestamptz IS NULL OR message.internal_date<${input.to ?? null}::timestamptz)
      AND (${input.cursor?.date ?? null}::timestamptz IS NULL OR (message.internal_date,message.id)>(${input.cursor?.date ?? null}::timestamptz,${input.cursor?.id ?? null}::uuid))
      AND NOT EXISTS(SELECT FROM mail.message_addresses sender JOIN mail.sender_identities identity
        ON identity.mailbox_id=message.mailbox_id AND lower(identity.from_address)=sender.normalized_email
        WHERE sender.message_id=message.id AND sender.role='from')
    ORDER BY message.internal_date,message.id LIMIT ${CODE_EVENT_CATCHUP_LIMIT + 1}
  `;
  const page = rows.slice(0, CODE_EVENT_CATCHUP_LIMIT);
  const last = page.at(-1);
  return ok({
    data: {
      cutoffAt,
      items: page.map((row) => ({ title: row.subject.slice(0, 998), event: mailCodeEvent(row) })),
      nextCursor: rows.length > CODE_EVENT_CATCHUP_LIMIT && last ? { date: new Date(last.internal_date).toISOString(), id: last.id } : null,
    },
  });
}

/** Source-owned resolver: the caller needs live mailbox read permission; caller-supplied receipt data is never used. */
export async function resolveMailCodeEvent(messageId: string, context: CapabilityExecutionContext) {
  const message = await resolvePublicId("messages", messageId);
  if (!message) return fail(err.notFound("Message"));
  const mailbox = await messageMailbox(message);
  if (!mailbox) return fail(err.notFound("Message"));
  const allowed = await requireMailboxAccess(requestContext(context), mailbox, "read");
  if (!allowed.ok || allowed.data.scope !== "mailbox") return fail(err.notFound("Message"));
  const [row] = await sql<Row[]>`SELECT message.id,message.short_id,message.mailbox_id,box.short_id AS mailbox,
    message.subject,message.internal_date,receipt.id AS receipt_id,receipt.first_seen_at
    FROM mail.message_contents message JOIN mail.mailboxes box ON box.id=message.mailbox_id
    JOIN LATERAL(SELECT ref.id,ref.first_seen_at FROM mail.remote_message_refs ref
      JOIN mail.folders folder ON folder.id=ref.folder_id
      WHERE ref.message_id=message.id AND folder.role NOT IN ('trash','junk','sent','drafts','all')
      ORDER BY ref.first_seen_at,ref.id LIMIT 1) receipt ON true
    WHERE message.id=${message}::uuid
      AND EXISTS(SELECT FROM mail.remote_message_refs ref JOIN mail.message_placements placement ON placement.remote_message_ref_id=ref.id
        JOIN mail.folders folder ON folder.id=ref.folder_id WHERE ref.message_id=message.id
          AND ref.stale_at IS NULL AND placement.deleted_at IS NULL AND folder.role NOT IN ('trash','junk','sent','drafts','all'))
      AND NOT EXISTS(SELECT FROM mail.message_addresses sender JOIN mail.sender_identities identity
        ON identity.mailbox_id=message.mailbox_id AND lower(identity.from_address)=sender.normalized_email
        WHERE sender.message_id=message.id AND sender.role='from')`;
  if (!row) return fail(err.notFound("Incoming message"));
  return ok({ data: mailCodeEvent(row) });
}

/** Calls the ordinary permission-aware message reader once; the returned data is a simulation fixture, never an effect. */
export async function previewMailCodeMessage(
  mailboxShortId: string,
  messageId: string,
  context: CapabilityExecutionContext,
  readMessage: () => Promise<Result<CapabilityResult<z.infer<typeof MessageDataSchema>>>>,
): Promise<Result<{ data: { event: ReturnType<typeof mailCodeEvent>; mock: CodeTestMock } }>> {
  const mailbox = await resolvePublicId("mailboxes", mailboxShortId);
  if (!mailbox) return fail(err.notFound("Mailbox"));
  const allowed = await requireMailboxAccess(requestContext(context), mailbox, "read");
  if (!allowed.ok) return fail(err.notFound("Mailbox"));
  const message = await resolveMailboxPublicId("messages", mailbox, messageId);
  if (!message) return fail(err.notFound("Message"));
  const read = await readMessage();
  if (!read.ok) return read;
  const resolved = await resolveMailCodeEvent(messageId, context);
  if (!resolved.ok) return resolved;
  return ok({
    data: {
      event: resolved.data.data,
      mock: {
        operation: "mail.message.read",
        target: null,
        input: { id: messageId },
        replies: [{ ok: true as const, data: read.data.data }],
      },
    },
  });
}
