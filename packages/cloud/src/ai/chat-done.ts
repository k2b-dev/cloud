import type { SQL } from "bun";
import { sql } from "../runtime/clients";
import { logger } from "../services/logging";
import { withAiShortIdForDb } from "./short-id";

/** A Cloud-authored fact. It never enters the model context or submits a turn. */
export type AiChatDone = {
  /** Stored only; public projection removes the immutable target coordinate. */
  targetConversationId?: string;
  chatId: string;
  turnId: string;
  status: "completed" | "failed" | "aborted";
  messageSeq: number | null;
  /** Snapshot projection only; current ownership decides whether the target is named and linked. */
  name?: string;
  href?: string;
};

/** The caller's terminal-turn transaction owns the destination lock. Never wait for another chat's lock:
 * two person-triggered turns may delegate to one another. A busy origin is repaired by the bounded sweep. */
export async function appendAiChatDone(turnId: string, db: SQL): Promise<void> {
  const [source] = await db<{ id: string; source_turn_id: string; target_id: string; chat_id: string; turn_id: string; status: AiChatDone["status"] }[]>`
    SELECT source.id, source_turn.id AS source_turn_id, target.id AS target_id, target.short_id AS chat_id, done.short_id AS turn_id, done.status
    FROM ai.turns done
    JOIN ai.conversations target ON target.id=done.conversation_id
    JOIN ai.chat_send_receipts receipt ON receipt.id=(done.run_config#>>'{send,id}')::uuid
      AND receipt.conversation_id=target.id AND receipt.account_id=target.created_by_user_id AND receipt.origin->>'kind'='chat'
    JOIN ai.conversations source ON source.id=receipt.source_conversation_id
      AND source.created_by_user_id=receipt.account_id AND source.archived_at IS NULL
    JOIN ai.turns source_turn ON source_turn.conversation_id=source.id
      AND source_turn.id=receipt.source_turn_id
    WHERE done.id=${turnId}::uuid AND done.status IN ('completed','failed','aborted')
      AND done.delegated_done_at IS NULL
      AND done.run_config#>>'{writerOrigin,kind}'='chat' AND done.run_config#>>'{send,id}' IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ai.messages fact
        WHERE fact.delegated_source_turn_id=source_turn.id AND fact.delegated_target_turn_id=done.id)
    FOR NO KEY UPDATE OF source SKIP LOCKED`;
  if (!source) {
    // A missing original source is final; a locked source is deferred. Old receipts have no UUID snapshot and
    // cannot be safely reconstructed from public IDs. Never redirect or resurrect their notification.
    await db`UPDATE ai.turns done SET delegated_done_at=now() WHERE done.id=${turnId}::uuid
      AND done.status IN ('completed','failed','aborted') AND done.delegated_done_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ai.chat_send_receipts receipt
        JOIN ai.conversations target ON target.id=receipt.conversation_id AND target.created_by_user_id=receipt.account_id
        JOIN ai.conversations source ON source.id=receipt.source_conversation_id
          AND source.created_by_user_id=receipt.account_id AND source.archived_at IS NULL
        JOIN ai.turns source_turn ON source_turn.id=receipt.source_turn_id AND source_turn.conversation_id=source.id
        WHERE receipt.id=(done.run_config#>>'{send,id}')::uuid AND receipt.conversation_id=done.conversation_id
          AND receipt.origin->>'kind'='chat'
          AND NOT EXISTS (SELECT 1 FROM ai.messages fact
            WHERE fact.delegated_source_turn_id=source_turn.id AND fact.delegated_target_turn_id=done.id))`;
    return;
  }
  // A fresh statement after acquiring the source lock sees the last committed sequence. The fact, its key and
  // the conversation bump commit together with the terminal status. Short-ID collisions use the shared savepoint.
  await withAiShortIdForDb(db, "idx_ai_messages_conversation_short_id", (attempt, shortId) => attempt`
    WITH inserted AS (
      INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message,search_text,meta,
        delegated_source_turn_id,delegated_target_turn_id)
      SELECT ${shortId},${source.id}::uuid,COALESCE((SELECT MAX(seq) FROM ai.messages
        WHERE conversation_id=${source.id}::uuid AND seq>0),0)+1,'message','assistant',
        '{"role":"assistant","content":[]}'::jsonb,'',
        jsonb_build_object('chatDone',jsonb_build_object('targetConversationId',${source.target_id}::text,
          'chatId',${source.chat_id}::text,'turnId',${source.turn_id}::text,
          'status',${source.status}::text,'messageSeq',COALESCE(
            (SELECT seq FROM ai.messages WHERE conversation_id=${source.target_id}::uuid AND loop_id=${turnId}::text AND role='assistant'
              AND jsonb_path_exists(message,'$.content[*] ? (@.type == "text" && @.text != "")') ORDER BY seq DESC LIMIT 1),
            (SELECT seq FROM ai.messages WHERE conversation_id=${source.target_id}::uuid AND loop_id=${turnId}::text AND role='user' ORDER BY seq LIMIT 1)))),
        ${source.source_turn_id}::uuid,${turnId}::uuid
      ON CONFLICT (delegated_source_turn_id,delegated_target_turn_id) WHERE delegated_source_turn_id IS NOT NULL DO NOTHING
      RETURNING conversation_id
    ), bumped AS (
      UPDATE ai.conversations SET updated_at=now(),last_used_at=now(),background_received_at=now(),done=NULL
      WHERE id IN (SELECT conversation_id FROM inserted)
    ) UPDATE ai.turns SET delegated_done_at=now() WHERE id=${turnId}::uuid`);
}

/** Restart repair, including turns ended by the runtime sweep. Shares its existing batch budget. */
export async function sweepAiChatDone(limit: number): Promise<void> {
  const turns = await sql<{ id: string }[]>`
    SELECT done.id FROM ai.turns done
    WHERE done.status IN ('completed','failed','aborted')
      AND done.delegated_done_at IS NULL
      AND done.run_config#>>'{writerOrigin,kind}'='chat' AND done.run_config#>>'{send,id}' IS NOT NULL
    ORDER BY done.completed_at,done.id LIMIT ${limit}`;
  for (const turn of turns) {
    try { await sql.begin((db) => appendAiChatDone(turn.id, db)); }
    catch { logger("ai:chat-done").warn("Chat completion recovery failed", { code: "chat_done_recovery_failed", turnId: turn.id }); }
  }
}
