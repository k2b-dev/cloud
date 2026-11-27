import type { SQL } from "bun";
import { sql } from "../runtime/clients";
import { type ConcurrentIndex, ensureConcurrentIndexes } from "../services/concurrent-index";
import { logger } from "../services/logging";

const log = logger("ai:conversations");

/**
 * The sidebar's open chats (`listSidebarConversations`): one person's chats that are not archived, pinned first, then
 * the most recently used, in exactly the query's order and direction, so the first page is read from the index in
 * order and the scan stops after it. Built in the background after the AI migration (`migrateCloudAi`).
 */
export const AI_CONVERSATION_SIDEBAR_INDEX: ConcurrentIndex = {
  name: "idx_ai_conversations_owner_sidebar",
  table: "ai.conversations",
  definition: "(created_by_user_id, pinned_at DESC NULLS LAST, last_used_at DESC, id) WHERE archived_at IS NULL",
};

/** Builds the sidebar index now; true once it is valid. Startup never awaits it (`buildConcurrentIndexesInBackground`). */
export const ensureAiConversationSidebarIndex = async (db: SQL = sql): Promise<boolean> => {
  const outcome = await ensureConcurrentIndexes([AI_CONVERSATION_SIDEBAR_INDEX], { db, log, purpose: "sidebar chat" });
  return outcome === "ready" || outcome === "built";
};
