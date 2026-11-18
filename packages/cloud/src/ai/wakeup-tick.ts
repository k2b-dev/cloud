import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { sql } from "../runtime/clients";
import { accounts } from "../services";
import { isAccountAllowed } from "../services/account-category-policy";
import { isAccountExpired } from "../services/account-model";
import { logger } from "../services/logging";
import { enqueueAiChatSend } from "./chat-send";
import { AiMessageQueueConflict } from "./message-queue";
import { personalAiModelPolicy } from "./personal-agent";
import { aiProjects } from "./projects";
import { AiQuotaError } from "./quotas";
import { prepareAiChatTurn, wakeAiMessageQueue } from "./runtime";
import type { AiModelProfile } from "./types";
import { isAiSettingsError } from "./validate";
import { readAiSettingsState } from "./settings";
import { selectAiModelProfile } from "./settings";
import { AI_WAKEUP_MISSED_DAYS, AI_WAKEUP_TICK_BATCH } from "./wakeup-contracts";
import { nextAiWakeupAt } from "./wakeup-time";
import { type AiWakeupRow, recordAiWakeupEvent } from "./wakeup-store";

const log = logger("ai:wakeups");
export class AiWakeupBudgetError extends Error {}
/** Core supplies the existing automation day allowance; the platform never reaches into Code data. */
export type AiWakeupBudgetCheck = (input: { owner: string; wakeupId: string; profile: AiModelProfile; db: SQL }) => Promise<void>;
export const aiWakeupOccurrenceId = (id: string, at: Date) => {
  const hex = createHash("sha256").update(JSON.stringify(["ai.chat.send", "wakeup", id, at.toISOString()])).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
};

/** One shared scheduler calls this once a minute. All durable work is outside the live-event path.
 * A no-op tick reads once. Each candidate locks chat then alarm and commits send + next time together. */
export async function tickAiWakeups(checkBudget: AiWakeupBudgetCheck, options: { now?: Date; signal?: AbortSignal; heartbeat?: () => Promise<unknown> } = {}) {
  const now = options.now ?? new Date();
  const candidates = await sql<{ id: string; conversation_id: string }[]>`SELECT w.id,w.conversation_id FROM ai.wakeups w
    JOIN ai.conversations c ON c.id=w.conversation_id
    WHERE c.archived_at IS NULL AND ((w.status='active' AND w.next_at<=${now})
      OR (w.status='missed' AND w.updated_at<=${new Date(+now - AI_WAKEUP_MISSED_DAYS * 86_400_000)}))
    ORDER BY w.next_at NULLS LAST,w.id LIMIT ${AI_WAKEUP_TICK_BATCH}`;
  let queued = 0;
  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    await options.heartbeat?.();
    try {
      const accepted = await sql.begin(async (db) => {
        const [chat] = await db<{ short_id: string; project_id: string | null; created_by_user_id: string | null; allowed_tools: string[] | null }[]>`
          SELECT short_id,project_id,created_by_user_id,allowed_tools FROM ai.conversations
          WHERE id=${candidate.conversation_id}::uuid AND archived_at IS NULL FOR UPDATE SKIP LOCKED`;
        if (!chat) return false;
        const [row] = await db<AiWakeupRow[]>`SELECT * FROM ai.wakeups WHERE id=${candidate.id}::uuid
          AND (status='missed' OR (status='active' AND next_at<=${now})) FOR UPDATE SKIP LOCKED`;
        if (!row) return false;
        const locale = (await db<{ locale: string | null }[]>`SELECT notification_locale AS locale FROM auth.users WHERE id=${row.created_by}::uuid`)[0]?.locale ?? "en";
        if (row.status === "missed") {
          // Recheck after locking: another request may have renewed or caught up this entry.
          const changed = await db<AiWakeupRow[]>`UPDATE ai.wakeups SET status='expired',next_at=NULL,revision=revision+1,updated_at=${now}
            WHERE id=${row.id}::uuid AND status='missed' AND updated_at<=${new Date(+now - AI_WAKEUP_MISSED_DAYS * 86_400_000)} RETURNING *`;
          if (changed[0]) await recordAiWakeupEvent(changed[0], "expired", locale, db, now);
          return false;
        }
        if (!row.next_at) return false;
        const scheduledAt = row.next_at;
        const id = aiWakeupOccurrenceId(row.id, scheduledAt);
        const [receipt] = await db`SELECT 1 FROM ai.chat_send_receipts WHERE id=${id}::uuid`;
        let reason: AiWakeupRow["missed_reason"] = null;
        let sent = false;
        if (!receipt) {
          const [waiting] = await db`SELECT 1 FROM ai.queued_messages WHERE conversation_id=${row.conversation_id}::uuid
            AND automation_source=${`wakeup:${row.id}`} AND status='pending' LIMIT 1`;
          if (waiting) reason = "queue_full";
          else {
            try {
              const user = await accounts.users.get({ id: row.created_by }, { db });
              if (!user || isAccountExpired(user.accountExpires) || !(await isAccountAllowed(user, db)) || chat.created_by_user_id !== row.created_by || chat.allowed_tools !== null) {
                reason = "access";
              } else {
                const actor = { kind: "user" as const, user };
                const accessSubject = { type: "user" as const, userId: user.id };
                const project = chat.project_id ? await aiProjects.snapshot(chat.project_id, { actor, accessSubject }) : null;
                if (chat.project_id && !project) reason = "access";
                else {
                  const keyHash = createHash("sha256").update(JSON.stringify([row.created_by, "ai.chat.send", id])).digest("hex");
                  const requestHash = createHash("sha256").update(JSON.stringify([chat.short_id, row.note, scheduledAt])).digest("hex");
                  const occurrence = { id: row.id, scheduledAt: scheduledAt.toISOString(), firedAt: now.toISOString(), snoozes: row.snoozes };
                  const prepared = await prepareAiChatTurn({
                    assistantChat: true, conversationId: row.conversation_id, chatId: chat.short_id, input: row.note,
                    userMessage: { role: "user", content: [{ type: "text", text: row.note }] }, actor, locale,
                    timeZone: row.timezone, writerOrigin: { kind: "wakeup", id: row.id, scheduledAt: occurrence.scheduledAt },
                    turnTrigger: { kind: "wakeup", id: row.id }, wakeup: occurrence,
                    send: { id, accountId: row.created_by, keyHash, requestHash }, modelPolicy: personalAiModelPolicy,
                    model: project?.defaultModel ?? undefined, project: project ?? undefined,
                    toolSource: { kind: "default", appTools: true }, toolApprovalContext: { actorUserId: user.id }, expectedProjectId: chat.project_id,
                    systemPrompt: `This is the chat owner's scheduled ai.chat.send. Planned time: ${occurrence.scheduledAt}. Actual time: ${occurrence.firedAt}. Alarm: ${row.id}. Postponements: ${row.snoozes}/3. Use current permissions and ordinary approvals. You may only postpone this same alarm, at most three times; never create another alarm.`,
                  });
                  const state = await readAiSettingsState();
                  const profile = selectAiModelProfile(state, personalAiModelPolicy, { id: prepared.modelId });
                  await checkBudget({ owner: row.created_by, wakeupId: row.id, profile, db });
                  options.signal?.throwIfAborted();
                  await enqueueAiChatSend(prepared, [{ type: "text", text: row.note }], db);
                  sent = true;
                }
              }
            } catch (error) {
              if (error instanceof AiMessageQueueConflict) reason = "queue_full";
              else if (error instanceof AiQuotaError || error instanceof AiWakeupBudgetError) reason = "budget";
              else if (isAiSettingsError(error)) reason = "access";
              else throw error;
            }
          }
        }
        const nextAt = row.cron && row.ends_at ? nextAiWakeupAt(row.cron, row.timezone, now, row.ends_at) : null;
        const status = row.cron ? (nextAt ? "active" : "expired") : reason ? "missed" : "done";
        const [updated] = await db<AiWakeupRow[]>`UPDATE ai.wakeups SET next_at=${status === "missed" ? scheduledAt : nextAt},status=${status},missed_reason=${reason},last_message_id=${sent || receipt ? id : null}::uuid,revision=revision+1,updated_at=${now}
          WHERE id=${row.id}::uuid RETURNING *`;
        if (reason) await recordAiWakeupEvent(updated!, "missed", locale, db, now);
        if (status === "expired") await recordAiWakeupEvent(updated!, "expired", locale, db, now);
        return sent;
      });
      if (accepted) { queued++; wakeAiMessageQueue(candidate.conversation_id); }
    } catch (error) {
      // Leave the durable due time untouched; the next minute retries this alarm, without blocking the rest of the batch.
      log.warn("Scheduled chat message could not be queued", { wakeupId: candidate.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { scanned: candidates.length, queued };
}
