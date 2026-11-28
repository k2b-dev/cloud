import type { ConcurrentIndex } from "../services/concurrent-index";

/**
 * The sidebar's open chats (`listSidebarConversations`): one person's chats that are not archived, pinned first, then
 * the most recently used, in exactly the query's order and direction, so the first page is read from the index in
 * order and the scan stops after it. `migrateCloudAi` creates it in its transaction when the catalog lacks it
 * (`createIndexIfMissing`), like the table's other indexes.
 */
export const AI_CONVERSATION_SIDEBAR_INDEX: ConcurrentIndex = {
  name: "idx_ai_conversations_owner_sidebar",
  table: "ai.conversations",
  definition: "(created_by_user_id, pinned_at DESC NULLS LAST, last_used_at DESC, id) WHERE archived_at IS NULL",
};
