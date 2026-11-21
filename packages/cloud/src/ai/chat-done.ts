import type { SQL } from "bun";
import { sql } from "../runtime/clients";
import { logger } from "../services/logging";
import { withAiShortIdForDb } from "./short-id";

/** A Cloud-authored fact. It never enters the model context or submits a turn. */
export type AiChatDone = {
  /** Stored only; public projection removes the immutable target coordinate. */
  targetConversationId?: string;
  chatId: string;
  /** Null when the queued request ended before a turn started. */
  turnId: string | null;
  status: "completed" | "failed" | "aborted";
  messageSeq: number | null;
  /** Snapshot projection only; current ownership decides whether the target is named and linked. */
  name?: string;
  href?: string;
  summary?: string;
};

type CompletionWork = { kind: "turn" | "queue"; id: string };
// Match the worker's five-attempt recovery budget. Lock contention does not consume an attempt.
const MAX_COMPLETION_FAILURES = 5;

const workQuery = (db: SQL, work: CompletionWork) =>
  work.kind === "turn"
    ? db`SELECT done.id,done.conversation_id,(done.run_config#>>'{send,id}')::uuid AS receipt_id,
      done.id AS target_turn_id,done.short_id AS turn_id,done.status
    FROM ai.turns done WHERE done.id=${work.id}::uuid AND done.status IN ('completed','failed','aborted')
      AND done.delegated_done_at IS NULL AND done.delegated_done_fail_count < ${MAX_COMPLETION_FAILURES}
      AND done.run_config#>>'{writerOrigin,kind}'='chat' AND done.run_config#>>'{send,id}' IS NOT NULL`
    : db`SELECT done.id,done.conversation_id,receipt.id AS receipt_id,NULL::uuid AS target_turn_id,
      NULL::text AS turn_id,CASE WHEN done.status='cancelled' THEN 'aborted' ELSE 'failed' END AS status
    FROM ai.queued_messages done JOIN ai.chat_send_receipts receipt ON receipt.queued_message_id=done.id
    WHERE done.id=${work.id}::uuid AND done.status IN ('cancelled','failed') AND done.submitted_turn_id IS NULL
      AND done.delegated_done_at IS NULL AND done.delegated_done_fail_count < ${MAX_COMPLETION_FAILURES}
      AND receipt.origin->>'kind'='chat'`;

const markSkippedUnlessBusy = async (db: SQL, work: CompletionWork) => {
  // A missing/archived origin is final, including after it is restored. A busy source is deferred.
  const busy = db`SELECT 1 FROM (${workQuery(db, work)}) work
    JOIN ai.chat_send_receipts receipt ON receipt.id=work.receipt_id AND receipt.origin->>'kind'='chat'
    JOIN ai.conversations target ON target.id=receipt.conversation_id AND target.created_by_user_id=receipt.account_id
    JOIN ai.conversations source ON source.id=receipt.source_conversation_id
      AND source.created_by_user_id=receipt.account_id AND source.archived_at IS NULL
    JOIN ai.turns source_turn ON source_turn.id=receipt.source_turn_id AND source_turn.conversation_id=source.id
    WHERE receipt.conversation_id=work.conversation_id
      AND NOT EXISTS (SELECT 1 FROM ai.messages fact WHERE fact.delegated_source_turn_id=source_turn.id
        AND (fact.delegated_target_turn_id=work.target_turn_id OR
          (work.target_turn_id IS NULL AND fact.delegated_send_receipt_id=receipt.id)))`;
  if (work.kind === "turn")
    await db`UPDATE ai.turns SET delegated_done_at=now() WHERE id=${work.id}::uuid
      AND delegated_done_at IS NULL AND delegated_done_fail_count < ${MAX_COMPLETION_FAILURES} AND NOT EXISTS (${busy})`;
  else
    await db`UPDATE ai.queued_messages SET delegated_done_at=now() WHERE id=${work.id}::uuid
      AND delegated_done_at IS NULL AND delegated_done_fail_count < ${MAX_COMPLETION_FAILURES} AND NOT EXISTS (${busy})`;
};

/** The target transaction owns its chat lock. The entire optional source write has one savepoint,
 * including its SELECT: a failed source must never undo the target's terminal state. */
async function appendDone(work: CompletionWork, db: SQL): Promise<void> {
  try {
    await withAiShortIdForDb(db, "idx_ai_messages_conversation_short_id", async (attempt, shortId) => {
      const [source] = await attempt<
        {
          id: string;
          source_turn_id: string;
          target_id: string;
          chat_id: string;
          turn_id: string | null;
          target_turn_id: string | null;
          receipt_id: string;
          status: AiChatDone["status"];
        }[]
      >`
        WITH work AS (${workQuery(attempt, work)})
        SELECT source.id,source_turn.id AS source_turn_id,target.id AS target_id,target.short_id AS chat_id,
          work.turn_id,work.target_turn_id,receipt.id AS receipt_id,work.status
        FROM work
        JOIN ai.conversations target ON target.id=work.conversation_id
        JOIN ai.chat_send_receipts receipt ON receipt.id=work.receipt_id
          AND receipt.conversation_id=target.id AND receipt.account_id=target.created_by_user_id AND receipt.origin->>'kind'='chat'
        JOIN ai.conversations source ON source.id=receipt.source_conversation_id
          AND source.created_by_user_id=receipt.account_id AND source.archived_at IS NULL
        JOIN ai.turns source_turn ON source_turn.conversation_id=source.id AND source_turn.id=receipt.source_turn_id
        WHERE NOT EXISTS (SELECT 1 FROM ai.messages fact WHERE fact.delegated_source_turn_id=source_turn.id
          AND (fact.delegated_target_turn_id=work.target_turn_id OR
            (work.target_turn_id IS NULL AND fact.delegated_send_receipt_id=receipt.id)))
        FOR NO KEY UPDATE OF source SKIP LOCKED`;
      if (!source) return markSkippedUnlessBusy(attempt, work);
      // A statement after taking the source lock sees its last committed sequence. The fact and marker commit together.
      const conflict =
        source.target_turn_id === null
          ? attempt`ON CONFLICT (delegated_source_turn_id,delegated_send_receipt_id) WHERE delegated_send_receipt_id IS NOT NULL DO NOTHING`
          : attempt`ON CONFLICT (delegated_source_turn_id,delegated_target_turn_id) WHERE delegated_source_turn_id IS NOT NULL DO NOTHING`;
      const marker =
        work.kind === "turn"
          ? attempt`UPDATE ai.turns SET delegated_done_at=now() WHERE id=${work.id}::uuid`
          : attempt`UPDATE ai.queued_messages SET delegated_done_at=now() WHERE id=${work.id}::uuid`;
      await attempt`
        WITH inserted AS (
          INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message,search_text,meta,
            delegated_source_turn_id,delegated_target_turn_id,delegated_send_receipt_id)
          SELECT ${shortId},${source.id}::uuid,COALESCE((SELECT MAX(seq) FROM ai.messages
            WHERE conversation_id=${source.id}::uuid AND seq>0),0)+1,'message','assistant',
            '{"role":"assistant","content":[]}'::jsonb,'',
            jsonb_build_object('chatDone',jsonb_build_object('targetConversationId',${source.target_id}::text,
              'chatId',${source.chat_id}::text,'turnId',${source.turn_id}::text,'status',${source.status}::text,
              'messageSeq',COALESCE(
                (SELECT seq FROM ai.messages WHERE conversation_id=${source.target_id}::uuid
                  AND loop_id=${source.target_turn_id}::text AND role='assistant'
                  AND jsonb_path_exists(message,'$.content[*] ? (@.type == "text" && @.text != "")') ORDER BY seq DESC LIMIT 1),
                (SELECT seq FROM ai.messages WHERE conversation_id=${source.target_id}::uuid
                  AND loop_id=${source.target_turn_id}::text AND role='user' ORDER BY seq LIMIT 1)))),
            ${source.source_turn_id}::uuid,${source.target_turn_id}::uuid,
            ${source.target_turn_id === null ? source.receipt_id : null}::uuid
          ${conflict} RETURNING conversation_id
        ), bumped AS (
          UPDATE ai.conversations SET updated_at=now(),last_used_at=now(),background_received_at=now(),done=NULL
          WHERE id IN (SELECT conversation_id FROM inserted)
        ) ${marker}`;
    });
  } catch (error) {
    // The savepoint has rolled back. Keep the marker NULL for recovery, but exclude poison work after five failures.
    if (work.kind === "turn") await db`UPDATE ai.turns SET delegated_done_fail_count=delegated_done_fail_count+1 WHERE id=${work.id}::uuid`;
    else await db`UPDATE ai.queued_messages SET delegated_done_fail_count=delegated_done_fail_count+1 WHERE id=${work.id}::uuid`;
    const code = error && typeof error === "object" ? (Reflect.get(error, "errno") ?? Reflect.get(error, "code")) : undefined;
    logger("ai:chat-done").warn("Chat completion deferred", {
      code: typeof code === "string" ? code : "chat_done_failed",
      kind: work.kind,
      id: work.id,
    });
  }
}

export const appendAiChatDone = (turnId: string, db: SQL): Promise<void> => appendDone({ kind: "turn", id: turnId }, db);
export const appendAiQueuedChatDone = (queueId: string, db: SQL): Promise<void> => appendDone({ kind: "queue", id: queueId }, db);

/** Restart repair, including turns ended by the runtime sweep and queue requests that never started. */
export async function sweepAiChatDone(limit: number): Promise<void> {
  const pending = await sql<(CompletionWork & { completed_at: Date })[]>`
    SELECT id,'turn' AS kind,completed_at FROM ai.turns
    WHERE status IN ('completed','failed','aborted') AND delegated_done_at IS NULL
      AND delegated_done_fail_count < ${MAX_COMPLETION_FAILURES}
      AND run_config#>>'{writerOrigin,kind}'='chat' AND run_config#>>'{send,id}' IS NOT NULL
    UNION ALL
    SELECT q.id,'queue',q.created_at FROM ai.queued_messages q
    JOIN ai.chat_send_receipts receipt ON receipt.queued_message_id=q.id AND receipt.origin->>'kind'='chat'
    WHERE q.status IN ('cancelled','failed') AND q.submitted_turn_id IS NULL AND q.origin->>'kind'='chat'
      AND q.delegated_done_at IS NULL AND q.delegated_done_fail_count < ${MAX_COMPLETION_FAILURES}
    ORDER BY completed_at,id LIMIT ${limit}`;
  for (const work of pending) {
    try {
      await sql.begin((db) => appendDone(work, db));
    } catch {
      logger("ai:chat-done").warn("Chat completion recovery failed", { code: "chat_done_recovery_failed", kind: work.kind, id: work.id });
    }
  }
}
