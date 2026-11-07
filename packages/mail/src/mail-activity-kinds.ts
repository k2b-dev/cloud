/**
 * What the mailbox's event feed lists: assignments, sends and their failures, drafts started or discarded, conversations
 * marked done or reopened, internal comments, and what automations did. Reading, flagging, and moving stay out. Plain
 * values without Zod, so the mailbox's first load can name them.
 */
export const MAIL_ACTIVITY_KINDS = ["assignment", "sent", "draft", "status", "comment", "automation"] as const;
export type MailActivityKind = (typeof MAIL_ACTIVITY_KINDS)[number];

export const isMailActivityKind = (value: unknown): value is MailActivityKind =>
  typeof value === "string" && (MAIL_ACTIVITY_KINDS as readonly string[]).includes(value);
