import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { SHORT_ID_REGEX } from "../lib/short-id";

type SqlClient = typeof sql;

export type MailPublicResourceTable =
  | "mailboxes"
  | "folders"
  | "conversations"
  | "messages"
  | "attachments"
  | "drafts"
  | "draftAttachments"
  | "senderIdentities"
  | "tags"
  | "comments"
  | "reminders"
  | "deliveries"
  | "savedViews"
  | "composeTemplates"
  | "incomingAutomations"
  | "automaticReplyConfigurations";

export type MailboxOwnedPublicResourceTable = Exclude<MailPublicResourceTable, "mailboxes">;

type ResourceRow = { id: string; short_id: string };

const rowsByShortIds = async (
  db: SqlClient,
  table: MailPublicResourceTable,
  shortIds: string[],
  mailboxId?: string,
): Promise<ResourceRow[]> => {
  const values = toPgTextArray(shortIds);
  switch (table) {
    case "mailboxes":
      return db`SELECT id, short_id FROM mail.mailboxes WHERE short_id = ANY(${values}::text[])`;
    case "folders":
      return mailboxId
        ? db`SELECT folder.id, folder.short_id FROM mail.folders folder
             JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
             WHERE resource.mailbox_id = ${mailboxId}::uuid AND folder.short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.folders WHERE short_id = ANY(${values}::text[])`;
    case "conversations":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.conversations WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.conversations WHERE short_id = ANY(${values}::text[])`;
    case "messages":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.message_contents WHERE short_id = ANY(${values}::text[])`;
    case "attachments":
      return mailboxId
        ? db`SELECT attachment.id, attachment.short_id FROM mail.attachments attachment
             JOIN mail.message_contents message ON message.id = attachment.message_id
             WHERE message.mailbox_id = ${mailboxId}::uuid AND attachment.short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.attachments WHERE short_id = ANY(${values}::text[])`;
    case "drafts":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.drafts WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.drafts WHERE short_id = ANY(${values}::text[])`;
    case "draftAttachments":
      return mailboxId
        ? db`SELECT attachment.id, attachment.short_id FROM mail.draft_attachments attachment
             JOIN mail.drafts draft ON draft.id = attachment.draft_id
             WHERE draft.mailbox_id = ${mailboxId}::uuid AND attachment.short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.draft_attachments WHERE short_id = ANY(${values}::text[])`;
    case "senderIdentities":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.sender_identities WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.sender_identities WHERE short_id = ANY(${values}::text[])`;
    case "tags":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.local_tags WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.local_tags WHERE short_id = ANY(${values}::text[])`;
    case "comments":
      return mailboxId
        ? db`SELECT comment.id, comment.short_id FROM mail.conversation_comments comment
             JOIN mail.conversations conversation ON conversation.id = comment.conversation_id
             WHERE conversation.mailbox_id = ${mailboxId}::uuid AND comment.short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.conversation_comments WHERE short_id = ANY(${values}::text[])`;
    case "reminders":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.conversation_reminders WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.conversation_reminders WHERE short_id = ANY(${values}::text[])`;
    case "deliveries":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.outbox_submissions WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.outbox_submissions WHERE short_id = ANY(${values}::text[])`;
    case "savedViews":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.saved_conversation_views WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.saved_conversation_views WHERE short_id = ANY(${values}::text[])`;
    case "composeTemplates":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.compose_templates WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.compose_templates WHERE short_id = ANY(${values}::text[])`;
    case "incomingAutomations":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.incoming_automations WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.incoming_automations WHERE short_id = ANY(${values}::text[])`;
    case "automaticReplyConfigurations":
      return mailboxId
        ? db`SELECT id, short_id FROM mail.automatic_reply_configurations WHERE mailbox_id = ${mailboxId}::uuid AND short_id = ANY(${values}::text[])`
        : db`SELECT id, short_id FROM mail.automatic_reply_configurations WHERE short_id = ANY(${values}::text[])`;
  }
};

const rowsByIds = async (db: SqlClient, table: MailPublicResourceTable, ids: string[]): Promise<ResourceRow[]> => {
  const values = toPgUuidArray(ids);
  switch (table) {
    case "mailboxes":
      return db`SELECT id, short_id FROM mail.mailboxes WHERE id = ANY(${values}::uuid[])`;
    case "folders":
      return db`SELECT id, short_id FROM mail.folders WHERE id = ANY(${values}::uuid[])`;
    case "conversations":
      return db`SELECT id, short_id FROM mail.conversations WHERE id = ANY(${values}::uuid[])`;
    case "messages":
      return db`SELECT id, short_id FROM mail.message_contents WHERE id = ANY(${values}::uuid[])`;
    case "attachments":
      return db`SELECT id, short_id FROM mail.attachments WHERE id = ANY(${values}::uuid[])`;
    case "drafts":
      return db`SELECT id, short_id FROM mail.drafts WHERE id = ANY(${values}::uuid[])`;
    case "draftAttachments":
      return db`SELECT id, short_id FROM mail.draft_attachments WHERE id = ANY(${values}::uuid[])`;
    case "senderIdentities":
      return db`SELECT id, short_id FROM mail.sender_identities WHERE id = ANY(${values}::uuid[])`;
    case "tags":
      return db`SELECT id, short_id FROM mail.local_tags WHERE id = ANY(${values}::uuid[])`;
    case "comments":
      return db`SELECT id, short_id FROM mail.conversation_comments WHERE id = ANY(${values}::uuid[])`;
    case "reminders":
      return db`SELECT id, short_id FROM mail.conversation_reminders WHERE id = ANY(${values}::uuid[])`;
    case "deliveries":
      return db`SELECT id, short_id FROM mail.outbox_submissions WHERE id = ANY(${values}::uuid[])`;
    case "savedViews":
      return db`SELECT id, short_id FROM mail.saved_conversation_views WHERE id = ANY(${values}::uuid[])`;
    case "composeTemplates":
      return db`SELECT id, short_id FROM mail.compose_templates WHERE id = ANY(${values}::uuid[])`;
    case "incomingAutomations":
      return db`SELECT id, short_id FROM mail.incoming_automations WHERE id = ANY(${values}::uuid[])`;
    case "automaticReplyConfigurations":
      return db`SELECT id, short_id FROM mail.automatic_reply_configurations WHERE id = ANY(${values}::uuid[])`;
  }
};

const internalIds = (values: string[], rows: ResourceRow[]): string[] | null => {
  const byShortId = new Map(rows.map((row) => [row.short_id, row.id]));
  return values.every((value) => byShortId.has(value)) ? values.map((value) => byShortId.get(value)!) : null;
};

export const resolvePublicIds = async (table: MailPublicResourceTable, values: string[], db: SqlClient = sql): Promise<string[] | null> => {
  if (values.length === 0) return [];
  if (values.some((value) => !SHORT_ID_REGEX.test(value))) return null;
  return internalIds(values, await rowsByShortIds(db, table, [...new Set(values)]));
};

export const resolvePublicId = async (table: MailPublicResourceTable, shortId: string, db: SqlClient = sql): Promise<string | null> =>
  (await resolvePublicIds(table, [shortId], db))?.[0] ?? null;

export const resolveMailboxPublicIds = async (
  table: MailboxOwnedPublicResourceTable,
  mailboxId: string,
  values: string[],
  db: SqlClient = sql,
): Promise<string[] | null> => {
  if (values.length === 0) return [];
  if (values.some((value) => !SHORT_ID_REGEX.test(value))) return null;
  return internalIds(values, await rowsByShortIds(db, table, [...new Set(values)], mailboxId));
};

export const resolveMailboxPublicId = async (
  table: MailboxOwnedPublicResourceTable,
  mailboxId: string,
  shortId: string,
  db: SqlClient = sql,
): Promise<string | null> => (await resolveMailboxPublicIds(table, mailboxId, [shortId], db))?.[0] ?? null;

/** Resolve a reminder link even after the reminder row was removed. */
export const resolveReminderNotificationSourceId = async (
  mailboxId: string,
  shortId: string,
  db: SqlClient = sql,
): Promise<string | null> => {
  if (!SHORT_ID_REGEX.test(shortId)) return null;
  const rows = await db<{ id: string }[]>`
    SELECT reminder.id
    FROM mail.conversation_reminders reminder
    WHERE reminder.mailbox_id = ${mailboxId}::uuid AND reminder.short_id = ${shortId}
    UNION
    SELECT delivery.source_id AS id
    FROM mail.collaboration_notification_deliveries delivery
    WHERE delivery.mailbox_id = ${mailboxId}::uuid
      AND delivery.kind = 'reminder'
      AND delivery.source_short_id = ${shortId}
  `;
  return rows.length === 1 ? rows[0]!.id : null;
};

export const publicIds = async (
  table: MailPublicResourceTable,
  values: Array<string | null | undefined>,
  db: SqlClient = sql,
): Promise<Map<string, string>> => {
  const ids = [...new Set(values.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map();
  return new Map((await rowsByIds(db, table, ids)).map((row) => [row.id, row.short_id]));
};

/** Browser workspaces cannot open deleted mailboxes; lifecycle APIs use resolvePublicId. */
export const resolveActiveMailboxId = async (shortId: string, db: SqlClient = sql): Promise<string | null> => {
  if (!SHORT_ID_REGEX.test(shortId)) return null;
  const [row] = await db<{ id: string }[]>`
    SELECT id FROM mail.mailboxes WHERE short_id = ${shortId} AND deleted_at IS NULL
  `;
  return row?.id ?? null;
};

export const requirePublicId = (ids: Map<string, string>, id: string): string => {
  const shortId = ids.get(id);
  if (!shortId) throw new Error(`Missing public ID for Mail resource ${id}`);
  return shortId;
};

export const projectResourceIds = async <T extends { id: string }>(
  table: MailPublicResourceTable,
  items: T[],
  db: SqlClient = sql,
): Promise<T[]> => {
  const ids = await publicIds(
    table,
    items.map((item) => item.id),
    db,
  );
  return items.map((item) => ({ ...item, id: requirePublicId(ids, item.id) }));
};

export const projectMailboxResourceIds = async <T extends { id: string; mailboxId: string }>(
  table: MailboxOwnedPublicResourceTable,
  items: T[],
  db: SqlClient = sql,
): Promise<T[]> => {
  const [ids, mailboxes] = await Promise.all([
    publicIds(
      table,
      items.map((item) => item.id),
      db,
    ),
    publicIds(
      "mailboxes",
      items.map((item) => item.mailboxId),
      db,
    ),
  ]);
  return items.map((item) => ({
    ...item,
    id: requirePublicId(ids, item.id),
    mailboxId: requirePublicId(mailboxes, item.mailboxId),
  }));
};
