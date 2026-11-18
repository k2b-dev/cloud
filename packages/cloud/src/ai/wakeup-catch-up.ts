import { sql } from "../runtime/clients";
import { enqueueAiChatSend } from "./chat-send";
import { aiProjects } from "./projects";
import { prepareAiChatTurn, wakeAiMessageQueue } from "./runtime";
import { AI_WAKEUP_MISSED_DAYS } from "./wakeup-contracts";
import { type AiWakeupRow, publicAiWakeup, recordAiWakeupEvent } from "./wakeup-store";
import { AiWakeupError, type AiWakeupAuthority, requireOwnedAiWakeupChat } from "./wakeups";

  /** Explicit catch-up is the person's message and resumes their held queue through normal send semantics. */
export async function catchUpAiWakeup(chatId: string, id: string, revision: number, subject: AiWakeupAuthority, locale: string, now = new Date()) {
    const chat = await requireOwnedAiWakeupChat(chatId, subject, sql);
    if (subject.turnId) throw new AiWakeupError("forbidden", "Only the person may catch up a missed alarm.");
    const [row] = await sql<AiWakeupRow[]>`SELECT * FROM ai.wakeups WHERE id=${id}::uuid AND conversation_id=${chat.id}::uuid
      AND status='missed' AND cron IS NULL AND updated_at>${new Date(+now - AI_WAKEUP_MISSED_DAYS * 86_400_000)}`;
    if (!row || row.revision !== revision) throw new AiWakeupError("conflict", "This missed alarm is no longer available.");
    const key = crypto.randomUUID();
    const prepared = await prepareAiChatTurn({
      assistantChat: true, signedInSession: true, conversationId: chat.id, chatId, actor: subject.actor,
      input: row.note, userMessage: { role: "user", content: [{ type: "text", text: row.note }] }, locale,
      writerOrigin: { kind: "person", id: row.created_by }, turnTrigger: { kind: "person", id: row.created_by },
      send: { id: key, accountId: row.created_by, keyHash: key, requestHash: key },
      toolSource: { kind: "default", appTools: true }, toolApprovalContext: { actorUserId: row.created_by }, expectedProjectId: chat.project_id,
      ...(chat.project_id ? { project: await aiProjects.snapshot(chat.project_id, subject) ?? undefined } : {}),
    });
    const result = await sql.begin(async (db) => {
      await requireOwnedAiWakeupChat(chatId, subject, db, true);
      const [updated] = await db<AiWakeupRow[]>`UPDATE ai.wakeups SET status='done',next_at=NULL,missed_reason=NULL,revision=revision+1,updated_at=${now}
        WHERE id=${id}::uuid AND conversation_id=${chat.id}::uuid AND status='missed' AND revision=${revision} RETURNING *`;
      if (!updated) throw new AiWakeupError("conflict", "The alarm changed. Read it again.");
      await enqueueAiChatSend(prepared, [{ type: "text", text: row.note }], db);
      await db`UPDATE ai.conversations SET queue_held_at=NULL WHERE id=${chat.id}::uuid`;
      await recordAiWakeupEvent(updated, "caught_up", locale, db, now);
      return publicAiWakeup(updated, locale);
    });
    wakeAiMessageQueue(chat.id);
    return result;
}
