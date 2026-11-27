import type { SQL } from "bun";
import { sql } from "../runtime/clients";
import { logger } from "../services/logging";
import { ensureAiConcurrentIndex } from "./concurrent-index";

const log = logger("ai:conversations");

/**
 * The sidebar's open chats (`listSidebarConversations`): one person's chats that are not archived, pinned first, then
 * the most recently used, in exactly the query's order and direction, so the first page is read from the index in
 * order and the scan stops after it. Built next to live writes; see `ensureAiConcurrentIndex`.
 */
export const ensureAiConversationSidebarIndex = (db: SQL = sql): Promise<boolean> =>
  ensureAiConcurrentIndex(db, {
    name: "idx_ai_conversations_owner_sidebar",
    table: "conversations",
    definition: "(created_by_user_id, pinned_at DESC NULLS LAST, last_used_at DESC, id) WHERE archived_at IS NULL",
    log,
    failed: "Sidebar chat index build failed; retrying at the next migration",
    unavailable: "Sidebar chat index unavailable; retrying at the next migration",
  });
