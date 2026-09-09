import { crypto } from "@k2b/stdlib";
import { isUniqueViolation } from "@k2b/cloud/services";
import type { SQL } from "bun";

export const SHORT_ID_REGEX = /^[0-9A-Za-z]{6}$/;
export const SHORT_ID_LENGTH = 6;

export type ShortIdTable =
  | "mailbox"
  | "folder"
  | "conversation"
  | "message"
  | "attachment"
  | "draft"
  | "draftAttachment"
  | "senderIdentity"
  | "tag"
  | "comment"
  | "reminder"
  | "delivery"
  | "savedView"
  | "composeTemplate"
  | "incomingAutomation"
  | "automaticReplyConfiguration";

const MAX_ATTEMPTS = 10;

const constraintByTable: Record<ShortIdTable, string> = {
  mailbox: "mailboxes_short_id_idx",
  folder: "folders_short_id_idx",
  conversation: "conversations_short_id_idx",
  message: "message_contents_short_id_idx",
  attachment: "attachments_short_id_idx",
  draft: "drafts_short_id_idx",
  draftAttachment: "draft_attachments_short_id_idx",
  senderIdentity: "sender_identities_short_id_idx",
  tag: "local_tags_short_id_idx",
  comment: "conversation_comments_short_id_idx",
  reminder: "conversation_reminders_short_id_idx",
  delivery: "outbox_submissions_short_id_idx",
  savedView: "saved_conversation_views_short_id_idx",
  composeTemplate: "compose_templates_short_id_idx",
  incomingAutomation: "incoming_automations_short_id_idx",
  automaticReplyConfiguration: "automatic_reply_configurations_short_id_idx",
};

export const newShortId = (): string => crypto.common.readableId(SHORT_ID_LENGTH);

const isShortIdCollision = (error: unknown, tables: readonly ShortIdTable[]): boolean =>
  tables.some((table) => isUniqueViolation(error, constraintByTable[table]));

export const withShortIdRetry = async <T>(tables: readonly ShortIdTable[], write: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!isShortIdCollision(error, tables)) throw error;
    }
  }
  throw new Error(`Failed to allocate a short ID for ${tables.join(", ")}`);
};

export const withShortId = <T>(table: ShortIdTable, write: (shortId: string) => Promise<T>): Promise<T> =>
  withShortIdRetry([table], () => write(newShortId()));

type SavepointedSql = SQL & { savepoint: <T>(write: (db: SQL) => Promise<T>) => Promise<T> };

const isTransaction = (db: SQL): db is SavepointedSql => typeof (db as Partial<SavepointedSql>).savepoint === "function";

export const withShortIdDb = <T>(db: SQL, table: ShortIdTable, write: (db: SQL, shortId: string) => Promise<T>): Promise<T> =>
  withShortId(table, (shortId) => (isTransaction(db) ? db.savepoint((attempt) => write(attempt, shortId)) : write(db, shortId)));
