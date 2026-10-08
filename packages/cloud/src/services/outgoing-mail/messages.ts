import type { ObjectRef } from "@k2b/sync";
import { type SQL, sql } from "bun";
import { z } from "zod";
import {
  type AdminMailFilter,
  type AdminMailRecord,
  type MailMessage,
  type MailPage,
  type MailPageParams,
  type MailRecord,
  MailRecordSchema,
  type MailStatus,
} from "../../contracts/outgoing-mail";
import { sanitizeEmailHtml } from "../../shared/email-html";
import { audit } from "../audit";
import { escapeLikePattern, parsePgJsonValue, toPgTextArray, toPgUuidArray } from "../postgres";
import type { UploadedAttachments } from "./attachments";
import { mailActorSnapshot, mailMessageId } from "./message";
import { type MailAuditContext, OutgoingMailError } from "./store";

export type MessageRow = {
  id: string;
  app_id: string;
  profile_id: string | null;
  profile_key: string;
  batch_id: string | null;
  ref_scope: string | null;
  ref_id: string | null;
  to_addresses: string[];
  recipient_count: number;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  headers: unknown;
  from_name: string | null;
  reply_to: string | null;
  message_id_header: string;
  attachments: unknown;
  attachment_refs: unknown;
  status: MailStatus;
  error_code: string | null;
  error_message: string | null;
  smtp_response: string | null;
  failures: unknown;
  attempt_count: number;
  next_attempt_at: Date | string | null;
  deadline_at: Date | string;
  actor_type: string | null;
  actor_id: string | null;
  actor_name: string | null;
  created_at: Date | string;
  cursor_created_at: string;
  sent_at: Date | string | null;
  content_purged_at: Date | string | null;
};
export type AcceptedProfile = {
  id: string;
  key: string;
  from_address: string;
  max_attachment_bytes: number;
  daily_recipient_limit: number | null;
  pace_per_minute: number;
};
type LogRow = Pick<
  MessageRow,
  | "id"
  | "app_id"
  | "profile_key"
  | "batch_id"
  | "ref_scope"
  | "ref_id"
  | "to_addresses"
  | "subject"
  | "text_body"
  | "attachments"
  | "status"
  | "error_code"
  | "error_message"
  | "smtp_response"
  | "failures"
  | "attempt_count"
  | "actor_id"
  | "actor_name"
  | "created_at"
  | "cursor_created_at"
  | "sent_at"
  | "content_purged_at"
>;
const logColumns = (db: SQL, includeText: boolean) => db`id, app_id, profile_key, batch_id, ref_scope, ref_id, to_addresses, subject,
  ${includeText ? db`text_body` : db`NULL::text AS text_body`}, attachments, status, error_code, error_message, smtp_response,
  failures, attempt_count, actor_id, actor_name, created_at, created_at::text AS cursor_created_at, sent_at, content_purged_at`;
const metadata = async (id: string): Promise<AdminMailRecord | undefined> => {
  const [row] = await sql<LogRow[]>`SELECT ${logColumns(sql, false)} FROM outgoing_mail.messages WHERE id = ${id}::uuid`;
  return row ? adminMessageRecord(row) : undefined;
};
const date = (value: Date | string) => new Date(value).toISOString();
export const messageRecord = (row: LogRow): MailRecord => ({
  id: row.id,
  profile: row.profile_key,
  to: row.to_addresses,
  subject: row.subject,
  ...(row.batch_id ? { batchId: row.batch_id } : {}),
  ...(row.ref_scope !== null && row.ref_id !== null ? { ref: { scope: row.ref_scope, id: row.ref_id } } : {}),
  ...(row.text_body !== null ? { text: row.text_body } : {}),
  attachments: MailRecordSchema.shape.attachments.parse(parsePgJsonValue(row.attachments)),
  status: row.status,
  ...(row.error_message ? { error: row.error_message } : {}),
  failures: MailRecordSchema.shape.failures.parse(parsePgJsonValue(row.failures)),
  attempts: row.attempt_count,
  ...(row.actor_id ? { actor: { id: row.actor_id, name: row.actor_name ?? row.actor_id } } : {}),
  createdAt: date(row.created_at),
  ...(row.sent_at ? { sentAt: date(row.sent_at) } : {}),
  ...(row.content_purged_at ? { contentPurgedAt: date(row.content_purged_at) } : {}),
});
export const adminMessageRecord = (row: LogRow): AdminMailRecord => {
  const { text: _text, ...record } = messageRecord(row);
  return {
    ...record,
    appId: row.app_id,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.smtp_response ? { response: row.smtp_response } : {}),
  };
};
export const messageAttachmentRefs = (row: Pick<MessageRow, "attachment_refs">): ObjectRef[] =>
  z
    .array(
      z.object({
        storeId: z.literal("cloud-outgoing-mail-attachments"),
        tenantId: z.string(),
        key: z.string(),
        size: z.int().nonnegative(),
        digest: z.string(),
      }),
    )
    .parse(parsePgJsonValue(row.attachment_refs) ?? []);
const read = async (id: string, appId?: string, db: SQL = sql): Promise<MessageRow | undefined> => {
  const [row] = await db<MessageRow[]>`SELECT *, created_at::text AS cursor_created_at FROM outgoing_mail.messages
    WHERE id = ${id}::uuid ${appId === undefined ? db`` : db`AND app_id = ${appId}`}`;
  return row;
};
const known = async (appId: string, key?: string, db: SQL = sql): Promise<MessageRow | undefined> => {
  if (key === undefined) return undefined;
  const [row] = await db<
    MessageRow[]
  >`SELECT *, created_at::text AS cursor_created_at FROM outgoing_mail.messages WHERE app_id = ${appId} AND idempotency_key = ${key}`;
  return row;
};
export const allowedMailProfile = async (db: SQL, appId: string, key?: string): Promise<AcceptedProfile> => {
  const [configured] = await db<{ exists: boolean }[]>`SELECT EXISTS(SELECT 1 FROM outgoing_mail.profiles) AS exists`;
  if (!configured?.exists) throw new OutgoingMailError("mail_unavailable", "No outgoing mail profile is configured.");
  const [profile] = await db<
    AcceptedProfile[]
  >`SELECT id, key, from_address, max_attachment_bytes, daily_recipient_limit, pace_per_minute FROM outgoing_mail.profiles
    WHERE ${key === undefined ? db`is_default` : db`key = ${key}`} FOR SHARE`;
  if (!profile)
    throw new OutgoingMailError(key === undefined ? "profile_required" : "profile_unknown", "Choose an available outgoing mail profile.");
  const [access] = await db<{ allowed: boolean }[]>`SELECT CASE
    WHEN EXISTS(SELECT 1 FROM outgoing_mail.app_access WHERE app_id = ${appId} AND mode = 'selected')
    THEN EXISTS(SELECT 1 FROM outgoing_mail.app_profiles WHERE app_id = ${appId} AND profile_id = ${profile.id}::uuid)
    ELSE EXISTS(SELECT 1 FROM outgoing_mail.profiles WHERE id = ${profile.id}::uuid AND is_default) END AS allowed`;
  if (!access?.allowed)
    throw new OutgoingMailError(
      key === undefined ? "profile_required" : "profile_not_allowed",
      "This application may not use the outgoing mail profile.",
    );
  return profile;
};
const recordMailAcceptance = async (
  appId: string,
  actor: ReturnType<typeof mailActorSnapshot>,
  target: { type: string; id?: string },
  metadata: Record<string, unknown>,
  db: SQL,
  allowed: boolean,
  errorCode?: string,
): Promise<void> => {
  await audit.record(
    {
      action: "outgoing_mail.send",
      outcome: allowed ? "allowed" : "denied",
      actor: actor ? { ...(actor.type === "user" ? { userId: actor.id } : {}), uid: actor.name, provider: actor.type } : { uid: appId },
      target,
      ...(errorCode ? { error: { code: errorCode } } : {}),
      metadata,
    },
    db,
  );
};
export const recordMailBatch = async (
  appId: string,
  messages: readonly MailMessage[],
  rows: readonly MessageRow[] = [],
  batchId?: string,
  db: SQL = sql,
  errorCode?: string,
): Promise<void> => {
  const actors = messages.flatMap((message) => {
    const actor = mailActorSnapshot(message?.actor);
    return actor ? [actor] : [];
  });
  await recordMailAcceptance(
    appId,
    actors[0],
    { type: "outgoing_mail_batch", id: batchId },
    {
      appId,
      batchId: batchId ?? null,
      count: messages.length,
      ids: rows.map((row) => row.id),
      profiles: [...new Set(rows.length ? rows.map((row) => row.profile_key) : messages.map((message) => message?.profile ?? null))],
      recipientCount: rows.length
        ? rows.reduce((sum, row) => sum + row.recipient_count, 0)
        : messages.reduce((sum, message) => sum + (message?.to?.length ?? 0), 0),
      actors,
    },
    db,
    batchId !== undefined,
    errorCode,
  );
};
export const recordMailSend = async (
  appId: string,
  message: MailMessage,
  row?: MessageRow,
  db: SQL = sql,
  errorCode?: string,
): Promise<void> => {
  const actor = mailActorSnapshot(message.actor);
  await recordMailAcceptance(
    appId,
    actor,
    { type: "outgoing_mail_message", id: row?.id },
    {
      appId,
      profile: row?.profile_key ?? message.profile ?? null,
      recipientCount: row?.recipient_count ?? message.to.length,
      ...(actor ? { actor } : {}),
      id: row?.id ?? null,
    },
    db,
    !!row,
    errorCode,
  );
};
export class MailQuotaError extends OutgoingMailError {
  constructor(
    public readonly limit: number,
    public readonly used: number,
    public readonly requested: number,
  ) {
    super("quota_exceeded", "The profile's rolling 24-hour recipient quota is exhausted.");
  }
}
export const mailQuotaUsed = async (db: SQL, appId: string, profileId: string): Promise<number> => {
  const [usage] = await db<{ used: number }[]>`SELECT COALESCE(sum(recipient_count), 0)::int AS used FROM outgoing_mail.messages
    WHERE app_id = ${appId} AND profile_id = ${profileId}::uuid AND status <> 'cancelled' AND created_at > now() - INTERVAL '24 hours'`;
  return usage?.used ?? 0;
};
/** Internal acceptance metadata; never accepted by the public mail schemas. */
export type MailAcceptanceOptions = { trustedHtml?: boolean };

export const insertMailMessage = async (
  db: SQL,
  appId: string,
  id: string,
  message: MailMessage,
  uploaded: UploadedAttachments,
  profile: AcceptedProfile,
  batchId?: string,
  options?: MailAcceptanceOptions,
): Promise<MessageRow | undefined> => {
  const actor = mailActorSnapshot(message.actor);
  const created = new Date();
  const [row] = await db<MessageRow[]>`INSERT INTO outgoing_mail.messages (
      id, app_id, profile_id, profile_key, lane, batch_id, idempotency_key, ref_scope, ref_id, to_addresses, recipient_count,
      subject, text_body, html_body, headers, from_name, reply_to, message_id_header, attachments, attachment_refs, status,
      deadline_at, actor_type, actor_id, actor_name, created_at
    ) VALUES (${id}::uuid, ${appId}, ${profile.id}::uuid, ${profile.key}, ${batchId ? "bulk" : "immediate"}, ${batchId ?? null}::uuid, ${message.key ?? null},
      ${message.ref?.scope ?? null}, ${message.ref?.id ?? null}, ${toPgTextArray(message.to)}::text[], ${message.to.length},
      ${message.subject}, ${message.text}, ${message.html === undefined ? null : options?.trustedHtml ? message.html : sanitizeEmailHtml(message.html)},
      ${message.headers ? JSON.stringify(message.headers) : null}::text::jsonb, ${message.fromName ?? null}, ${message.replyTo ?? null},
      ${mailMessageId(id, profile.from_address)}, ${JSON.stringify(uploaded.metadata)}::text::jsonb, ${JSON.stringify(uploaded.refs)}::text::jsonb, 'queued',
      ${new Date(created.getTime() + 24 * 60 * 60_000)}, ${actor?.type ?? null}, ${actor?.id ?? null}, ${actor?.name ?? null}, ${created})
      ON CONFLICT (app_id, idempotency_key) DO NOTHING RETURNING *, created_at::text AS cursor_created_at`;
  return row;
};

const accept = async (
  appId: string,
  id: string,
  message: MailMessage,
  uploaded: UploadedAttachments,
  options?: MailAcceptanceOptions,
): Promise<{ row: MessageRow; created: boolean }> =>
  sql.begin(async (tx) => {
    // Policy writers take this exclusively; batches take the app lock exclusively.
    // Lock order: policy -> app -> key -> quota. Sends still serialize per key.
    await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended('outgoing_mail.policy', 0))`;
    if (message.key !== undefined) {
      await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${appId}, 5))`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([appId, message.key])}, 1))`;
    }
    const existing = await known(appId, message.key, tx);
    if (existing) {
      return { row: existing, created: false };
    }
    const profile = await allowedMailProfile(tx, appId, message.profile);
    if (uploaded.metadata.reduce((bytes, item) => bytes + item.size, 0) > profile.max_attachment_bytes)
      throw new OutgoingMailError("attachments_too_large", "Attachments exceed the profile's total byte limit.");
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([appId, profile.id])}, 2))`;
    const used = await mailQuotaUsed(tx, appId, profile.id);
    if (profile.daily_recipient_limit !== null && used + message.to.length > profile.daily_recipient_limit)
      throw new MailQuotaError(profile.daily_recipient_limit, used, message.to.length);
    const row = await insertMailMessage(tx, appId, id, message, uploaded, profile, undefined, options);
    if (row) await recordMailSend(appId, message, row, tx);
    const winner = row ?? (await known(appId, message.key, tx));
    if (!winner) throw new Error("Outgoing mail insert returned no row");
    return { row: winner, created: !!row };
  });

const cursorSchema = z
  .object({ createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))), id: z.uuid(), page: z.int().min(1) })
  .strict();
export const decodeMailCursor = (cursor?: string) => {
  if (cursor === undefined) return undefined;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new OutgoingMailError("bad_input", "Invalid outgoing mail cursor.");
  }
};
const list = async (
  filter: AdminMailFilter,
  page: MailPageParams = {},
  metadata = false,
): Promise<MailPage<MailRecord | AdminMailRecord>> => {
  const cursor = decodeMailCursor(page.cursor);
  const perPage = page.perPage ?? 50;
  const pageNumber = cursor?.page ?? page.page ?? 1;
  const where = sql`WHERE TRUE
    ${filter.app === undefined ? sql`` : sql`AND app_id = ${filter.app}`}
    ${filter.profile === undefined ? sql`` : sql`AND profile_key = ${filter.profile}`}
    ${filter.ids === undefined ? sql`` : sql`AND id = ANY(${toPgUuidArray(filter.ids)}::uuid[])`}
    ${filter.batchId === undefined ? sql`` : sql`AND batch_id = ${filter.batchId}::uuid`}
    ${filter.status === undefined ? sql`` : sql`AND status = ANY(${toPgTextArray(filter.status)}::text[])`}
    ${filter.since === undefined ? sql`` : sql`AND created_at >= ${filter.since}::timestamptz`}
    ${filter.ref === undefined ? sql`` : sql`AND ref_scope = ${filter.ref.scope}`}
    ${filter.ref?.id === undefined ? sql`` : sql`AND ref_id = ${filter.ref.id}`}
    ${filter.recipient === undefined ? sql`` : sql`AND EXISTS(SELECT 1 FROM unnest(to_addresses) AS address WHERE address ILIKE ${`%${escapeLikePattern(filter.recipient)}%`})`}`;
  const [count] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM outgoing_mail.messages ${where}`;
  const rows = await sql<LogRow[]>`SELECT ${logColumns(sql, !metadata)} FROM outgoing_mail.messages ${where}
    ${cursor ? sql`AND (created_at < ${cursor.createdAt}::timestamptz OR (created_at = ${cursor.createdAt}::timestamptz AND id > ${cursor.id}::uuid))` : sql``}
    ORDER BY created_at DESC, id LIMIT ${perPage + 1} OFFSET ${cursor ? 0 : (pageNumber - 1) * perPage}`;
  const hasNext = rows.length > perPage;
  const items = rows.slice(0, perPage);
  const last = items.at(-1);
  return {
    items: items.map(metadata ? adminMessageRecord : messageRecord),
    page: pageNumber,
    perPage,
    total: count?.total ?? 0,
    hasNext,
    ...(hasNext && last
      ? {
          nextCursor: Buffer.from(JSON.stringify({ createdAt: last.cursor_created_at, id: last.id, page: pageNumber + 1 })).toString(
            "base64url",
          ),
        }
      : {}),
  };
};
const content = async (id: string, context: MailAuditContext) =>
  sql.begin(async (tx) => {
    const row = await read(id, undefined, tx);
    if (!row) throw new OutgoingMailError("message_unknown", "Outgoing mail message does not exist.", 404);
    await audit.record(
      {
        ...context,
        action: "outgoing_mail.message.read",
        outcome: "allowed",
        target: { type: "outgoing_mail_message", id },
        metadata: { appId: row.app_id },
      },
      tx,
    );
    return row.content_purged_at
      ? { purged: true as const, contentPurgedAt: date(row.content_purged_at) }
      : {
          purged: false as const,
          text: row.text_body,
          html: row.html_body,
          headers: z.record(z.string(), z.string()).nullable().parse(parsePgJsonValue(row.headers)),
        };
  });
export const outgoingMailMessages = { read, metadata, known, accept, list, content };
