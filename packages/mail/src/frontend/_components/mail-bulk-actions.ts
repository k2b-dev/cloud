export const MAIL_BULK_CONCURRENCY = 4;
export const MAIL_BULK_NO_PROVIDER_PLACEMENT = "mail_bulk_no_provider_placement";
export const MAIL_BULK_QUEUE_FAILED = "mail_bulk_queue_failed";

export type MailBulkTarget = {
  conversationId: string;
  label: string;
  sourceFolderIds: readonly string[];
  /** The messages of the conversation a message-list row stands for; without them, the action takes the whole conversation. */
  messageIds?: readonly string[];
};
