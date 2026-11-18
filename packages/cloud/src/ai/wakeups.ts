import type { SQL } from "bun";
import { sql } from "../runtime/clients";
import { aiProjects } from "./projects";
import type { AiResourceContext } from "./projects-authorization";
import type { AiChatTurnRunConfig } from "./types";
import {
  AI_WAKEUP_CHAT_LIMIT,
  AI_WAKEUP_SNOOZE_LIMIT,
  type AiWakeupInput,
  AiWakeupInputSchema,
  type AiWakeupPatch,
  AiWakeupPatchSchema,
} from "./wakeup-contracts";
import { type AiWakeupRow, publicAiWakeup, recordAiWakeupEvent } from "./wakeup-store";
import { prepareAiWakeupTime } from "./wakeup-time";

export class AiWakeupError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "limit" | "conflict" | "invalid" | "snooze_limit",
    message: string,
  ) {
    super(message);
  }
}
export type AiWakeupAuthority = AiResourceContext & { turnId?: string };
/** One authority check for API and tools. Lock order everywhere is chat -> alarm -> budget. */
export async function requireOwnedAiWakeupChat(chatId: string, subject: AiWakeupAuthority, db: SQL, write = false) {
  const { actor, accessSubject } = subject;
  if (
    actor.kind !== "user" ||
    actor.sessionKind === "app" ||
    actor.delegation ||
    accessSubject.type !== "user" ||
    accessSubject.userId !== actor.user.id
  )
    throw new AiWakeupError("forbidden", "Alarms require the chat owner's unrestricted access.");
  const [chat] = await db<{ id: string; project_id: string | null; archived_at: Date | null; allowed_tools: string[] | null }[]>`
    SELECT id,project_id,archived_at,allowed_tools FROM ai.conversations
    WHERE short_id=${chatId} AND created_by_user_id=${actor.user.id}::uuid ${write ? db`FOR UPDATE` : db``}`;
  if (!chat) throw new AiWakeupError("not_found", "Chat not found.");
  if (chat.allowed_tools !== null || (write && chat.archived_at))
    throw new AiWakeupError("forbidden", "This chat cannot schedule messages.");
  if (chat.project_id && !(await aiProjects.get(chat.project_id, subject, "read", db)))
    throw new AiWakeupError("forbidden", "Project access is unavailable.");
  let trigger: AiChatTurnRunConfig["turnTrigger"];
  if (subject.turnId) {
    const [turn] = await db<{ run_config: AiChatTurnRunConfig }[]>`SELECT run_config FROM ai.turns
      WHERE id=${subject.turnId}::uuid AND conversation_id=${chat.id}::uuid AND status='running' AND cancel_requested_at IS NULL`;
    if (
      !turn ||
      turn.run_config.kind !== "chat" ||
      !turn.run_config.assistantChat ||
      turn.run_config.toolSource?.kind !== "default" ||
      turn.run_config.codeReview ||
      turn.run_config.mandate ||
      turn.run_config.background ||
      turn.run_config.sourceRestricted ||
      turn.run_config.actor?.kind !== "user" ||
      turn.run_config.actor.user.id !== actor.user.id ||
      turn.run_config.actor.sessionKind === "app" ||
      turn.run_config.actor.delegation
    )
      throw new AiWakeupError("forbidden", "This turn cannot manage alarms.");
    trigger = turn.run_config.turnTrigger;
    if (trigger?.kind !== "person" && trigger?.kind !== "wakeup")
      throw new AiWakeupError("forbidden", "Only the person or this alarm may change it.");
    if (trigger.kind === "person" && trigger.id !== actor.user.id) throw new AiWakeupError("forbidden", "The turn owner changed.");
  }
  return { ...chat, trigger, owner: actor.user.id };
}

async function capacity(conversationId: string, db: SQL, exclude?: string) {
  const [row] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.wakeups
    WHERE conversation_id=${conversationId}::uuid AND status IN ('active','missed','expired') AND id IS DISTINCT FROM ${exclude ?? null}::uuid`;
  if (row!.count >= AI_WAKEUP_CHAT_LIMIT)
    throw new AiWakeupError("limit", "This chat already has five alarms. Change or delete one first.");
}
const validatedTime = (input: AiWakeupInput, now: Date) => {
  try {
    return prepareAiWakeupTime(input, now);
  } catch (error) {
    throw new AiWakeupError("invalid", error instanceof Error ? error.message : "Choose a valid time.");
  }
};
const note = (input: AiWakeupInput | AiWakeupPatch) => {
  const parsed = "revision" in input ? AiWakeupPatchSchema.safeParse(input) : AiWakeupInputSchema.safeParse(input);
  if (!parsed.success) throw new AiWakeupError("invalid", "Check the alarm's time and note.");
};

/** Same retirement shape as ordinary queue cancellation, including release of queued file bytes. */
async function cancelPendingAiWakeupMessages(conversationId: string, wakeupId: string, db: SQL) {
  await db`WITH cancelled AS (
    UPDATE ai.queued_messages SET status='cancelled',error=NULL,revision=revision+1,
      submission=jsonb_build_object('runConfig',jsonb_build_object('send',submission#>'{runConfig,send}','turnTrigger',submission#>'{runConfig,turnTrigger}')),
      content='[]'::jsonb WHERE conversation_id=${conversationId}::uuid AND automation_source=${`wakeup:${wakeupId}`} AND status='pending' RETURNING id
  ) DELETE FROM ai.queued_message_files f USING cancelled WHERE f.message_id=cancelled.id`;
}

export const aiWakeups = {
  async list(chatId: string, subject: AiWakeupAuthority, locale: string) {
    const chat = await requireOwnedAiWakeupChat(chatId, subject, sql);
    const rows = await sql<AiWakeupRow[]>`SELECT * FROM ai.wakeups WHERE conversation_id=${chat.id}::uuid
      AND (status IN ('active','missed','expired') OR id=${chat.trigger?.kind === "wakeup" ? chat.trigger.id : null}::uuid)
      ORDER BY next_at NULLS LAST,created_at LIMIT ${AI_WAKEUP_CHAT_LIMIT + (chat.trigger?.kind === "wakeup" ? 1 : 0)}`;
    return { items: rows.map((row) => publicAiWakeup(row, locale)), limit: AI_WAKEUP_CHAT_LIMIT, paused: Boolean(chat.archived_at) };
  },
  async create(chatId: string, input: AiWakeupInput, subject: AiWakeupAuthority, locale: string, now = new Date()) {
    note(input);
    const time = validatedTime(input, now);
    return sql.begin(async (db) => {
      const chat = await requireOwnedAiWakeupChat(chatId, subject, db, true);
      if (chat.trigger?.kind === "wakeup") throw new AiWakeupError("forbidden", "An alarm turn cannot create another alarm.");
      await capacity(chat.id, db);
      const [row] = await db<AiWakeupRow[]>`INSERT INTO ai.wakeups(id,conversation_id,created_by,next_at,cron,timezone,ends_at,note)
        VALUES(${crypto.randomUUID()}::uuid,${chat.id}::uuid,${chat.owner}::uuid,${time.nextAt},${time.cron},${time.timezone},${time.endsAt},${input.note.trim()}) RETURNING *`;
      await recordAiWakeupEvent(row!, "created", locale, db, now);
      return publicAiWakeup(row!, locale);
    });
  },
  async update(chatId: string, id: string, input: AiWakeupPatch, subject: AiWakeupAuthority, locale: string, now = new Date()) {
    note(input);
    return sql.begin(async (db) => {
      const chat = await requireOwnedAiWakeupChat(chatId, subject, db, true);
      const [row] = await db<AiWakeupRow[]>`SELECT * FROM ai.wakeups WHERE id=${id}::uuid AND conversation_id=${chat.id}::uuid FOR UPDATE`;
      if (!row) throw new AiWakeupError("not_found", "Alarm not found.");
      if (row.revision !== input.revision) throw new AiWakeupError("conflict", "The alarm changed. Read it again.");
      const snooze = chat.trigger?.kind === "wakeup";
      if (snooze && (chat.trigger?.id !== id || !input.at || Object.keys(input).some((key) => key !== "at" && key !== "revision")))
        throw new AiWakeupError("forbidden", "An alarm turn may only postpone its own time.");
      if (snooze && row.snoozes >= AI_WAKEUP_SNOOZE_LIMIT)
        throw new AiWakeupError("snooze_limit", "This alarm has already been postponed three times.");
      if (snooze && row.status === "deleted") throw new AiWakeupError("forbidden", "The person deleted this alarm.");
      const cron = input.cron === undefined ? row.cron : input.cron;
      const unchangedTime =
        input.at === undefined && input.cron === undefined && input.endsAt === undefined && (!cron || input.timezone === undefined);
      const time = validatedTime(
        {
          note: input.note ?? row.note,
          timezone: input.timezone ?? row.timezone,
          cron,
          ...(unchangedTime && row.next_at ? { at: row.next_at.toISOString() } : input.at ? { at: input.at } : {}),
          endsAt: input.endsAt === undefined ? (cron ? row.ends_at?.toISOString() : null) : input.endsAt,
        },
        now,
      );
      await capacity(chat.id, db, id);
      const [updated] = await db<
        AiWakeupRow[]
      >`UPDATE ai.wakeups SET next_at=${time.nextAt},cron=${time.cron},timezone=${time.timezone},ends_at=${time.endsAt},
        note=${input.note?.trim() ?? row.note},snoozes=${snooze ? row.snoozes + 1 : 0},status='active',missed_reason=NULL,last_message_id=NULL,revision=revision+1,updated_at=${now}
        WHERE id=${id}::uuid RETURNING *`;
      // A person's edit replaces the old commitment, including a due message still waiting in the queue.
      await cancelPendingAiWakeupMessages(chat.id, id, db);
      await recordAiWakeupEvent(updated!, "updated", locale, db, now);
      return publicAiWakeup(updated!, locale);
    });
  },
  async remove(chatId: string, id: string, revision: number, subject: AiWakeupAuthority, locale: string, now = new Date()) {
    return sql.begin(async (db) => {
      const chat = await requireOwnedAiWakeupChat(chatId, subject, db, true);
      if (chat.trigger?.kind === "wakeup" && chat.trigger.id !== id)
        throw new AiWakeupError("forbidden", "An alarm turn may only delete its own alarm.");
      const [row] = await db<AiWakeupRow[]>`UPDATE ai.wakeups SET status='deleted',next_at=NULL,revision=revision+1,updated_at=${now}
        WHERE id=${id}::uuid AND conversation_id=${chat.id}::uuid AND revision=${revision} AND status<>'deleted' RETURNING *`;
      if (!row) throw new AiWakeupError("conflict", "The alarm changed. Read it again.");
      await cancelPendingAiWakeupMessages(chat.id, id, db);
      await recordAiWakeupEvent(row, "deleted", locale, db, now);
      return publicAiWakeup(row, locale);
    });
  },
};
