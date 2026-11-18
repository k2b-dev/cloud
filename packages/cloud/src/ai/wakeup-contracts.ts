import { z } from "zod";

/** F3 A, Gustav alarms v1: bounded per-chat commitments, separate from the automation queue's 32 places. */
export const AI_WAKEUP_CHAT_LIMIT = 5;
/** F3 A: never run a recurring alarm more frequently than every quarter hour. */
export const AI_WAKEUP_MIN_INTERVAL_MINUTES = 15;
/** F3 A: recurring commitments need a person's renewal after 30 days. */
export const AI_WAKEUP_LIFETIME_DAYS = 30;
/** F3 A: a one-off commitment cannot extend beyond one calendar year. */
export const AI_WAKEUP_MAX_YEARS = 1;
/** F2 A: an unattended turn may postpone its own alarm at most three times. */
export const AI_WAKEUP_SNOOZE_LIMIT = 3;
/** Alarm v1 data contract: a short instruction, not another stored document. */
export const AI_WAKEUP_NOTE_CHARACTERS = 200;
/** Alarm v1 tick contract: leave excess due work for the next minute. */
export const AI_WAKEUP_TICK_BATCH = 100;
/** Alarm v1 recovery contract: a missed one-off remains actionable for seven days. */
export const AI_WAKEUP_MISSED_DAYS = 7;

export const AiWakeupInputSchema = z.strictObject({
  at: z.iso.datetime({ offset: true }).optional(),
  cron: z.string().trim().min(1).nullable().optional(),
  timezone: z.string().trim().min(1),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  note: z.string().trim().min(1).refine((text) => [...text].length <= AI_WAKEUP_NOTE_CHARACTERS, "The note is too long."),
});
export const AiWakeupPatchSchema = AiWakeupInputSchema.partial().extend({
  /** Optimistic concurrency: list/create/update returns the current revision. */
  revision: z.number().int().nonnegative(),
}).refine((input) => Object.keys(input).length > 1, "Supply a change.");
export const AiWakeupSchema = z.strictObject({
  id: z.uuid(),
  at: z.string().nullable(),
  cron: z.string().nullable(),
  timezone: z.string(),
  endsAt: z.string().nullable(),
  note: z.string(),
  snoozes: z.number().int(),
  status: z.enum(["active", "missed", "expired", "done", "deleted"]),
  missedReason: z.enum(["access", "budget", "queue_full"]).nullable(),
  revision: z.number().int(),
  rhythm: z.string(),
});
export type AiWakeup = z.infer<typeof AiWakeupSchema>;
export type AiWakeupInput = z.infer<typeof AiWakeupInputSchema>;
export type AiWakeupPatch = z.infer<typeof AiWakeupPatchSchema>;
export type AiWakeupOccurrence = { id: string; scheduledAt: string; firedAt: string; snoozes: number };
export type AiWakeupEvent = {
  id: string;
  kind: "created" | "updated" | "deleted" | "missed" | "expired" | "caught_up";
  at: string;
  wakeup: AiWakeup;
};
