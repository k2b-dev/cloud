import { lazySync } from "../_internal/process-sync";
import { sql } from "../runtime/clients";
import { logger } from "../services/logging";

const log = logger("ai:conversation-watchers");

/**
 * A watch lives this long without a refresh, so a replica that stops without
 * closing its streams leaves no watcher behind for longer.
 */
const AI_WATCH_TTL_MS = 30_000;
/** An open stream refreshes its watch at most this often; a third of the TTL survives two lost refreshes. */
const AI_WATCH_REFRESH_MS = 10_000;

/**
 * Signed-in browser tabs that stream a conversation now: one entry per open
 * stream, keyed by the conversation as tenant. A person who watches sees an
 * approval in the page, so Cloud sends no notice or Cloud Login push for it.
 */
const aiConversationWatchers = lazySync((sync) =>
  sync.ephemeral<true>({ id: "cloud-ai-conversation-watchers", owner: "cloud", ttlMs: AI_WATCH_TTL_MS }),
);

const watchedBy = async (conversationId: string, except?: string): Promise<boolean> => {
  const { entries } = await aiConversationWatchers().snapshot({ tenantId: conversationId });
  return entries.some((entry) => entry.key !== except);
};

export type AiConversationWatch = {
  /** Keeps the watch alive; the stream calls it on each heartbeat. */
  refresh: () => void;
  /** Ends the watch once. When no other tab watches, `onUnwatched` runs; the promise never rejects. */
  release: () => Promise<void>;
};

/**
 * Registers one open stream as a watcher of the conversation before the stream
 * sends its first state. Registration and refresh failures only log: an
 * unregistered tab means Cloud also notifies outside the page, never that it
 * stays silent.
 */
export const watchAiConversation = async (conversationId: string, onUnwatched: () => Promise<void>): Promise<AiConversationWatch> => {
  const key = crypto.randomUUID();
  let released = false;
  let refreshedAt = 0;
  let write: Promise<unknown> = Promise.resolve();
  const put = () => {
    refreshedAt = Date.now();
    write = write
      .then(() => aiConversationWatchers().upsert({ tenantId: conversationId, key, value: true }))
      .catch((error) =>
        log.warn("AI conversation watch failed", { conversationId, error: error instanceof Error ? error.message : "watch failed" }),
      );
  };
  put();
  await write;
  return {
    refresh: () => {
      if (!released && Date.now() - refreshedAt >= AI_WATCH_REFRESH_MS) put();
    },
    release: async () => {
      if (released) return;
      released = true;
      // After the last write, so a late registration cannot outlive the release.
      await write
        .then(() => aiConversationWatchers().delete({ tenantId: conversationId, key }))
        .catch(() => undefined)
        // This stream's own entry never counts, even when its delete failed.
        .then(() => watchedBy(conversationId, key))
        .then((watched) => (watched ? undefined : onUnwatched()))
        .catch((error) =>
          log.warn("AI conversation unwatch failed", { conversationId, error: error instanceof Error ? error.message : "unwatch failed" }),
        );
    },
  };
};

/**
 * Whether the person can only learn about this approval outside the page: no
 * signed-in browser tab streams a conversation that waits on it. Cloud Login
 * push and the Pending approvals notification share this one rule. When the
 * watchers cannot be read, the approval counts as unwatched, so a notice may
 * repeat what a tab shows but is never lost.
 */
export const aiApprovalUnwatched = async (approvalId: string): Promise<boolean> => {
  const rows = await sql<{ conversation_id: string }[]>`
    SELECT DISTINCT conversation_id FROM ai.pending_actions WHERE approval_id=${approvalId}::uuid AND status='pending'`;
  try {
    for (const row of rows) if (await watchedBy(row.conversation_id)) return false;
  } catch (error) {
    log.warn("AI conversation watchers unavailable", {
      approvalId,
      error: error instanceof Error ? error.message : "watchers unavailable",
    });
  }
  return true;
};

/** Approvals a conversation's turns wait on now. A conversation runs one turn at a time, which bounds the list. */
export const waitingAiApprovals = async (conversationId: string): Promise<string[]> => {
  const rows = await sql<{ approval_id: string }[]>`
    SELECT DISTINCT approval_id FROM ai.pending_actions
    WHERE conversation_id=${conversationId}::uuid AND status='pending' AND approval_id IS NOT NULL`;
  return rows.map((row) => row.approval_id);
};
