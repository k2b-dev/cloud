import { type CapabilityGrant, CapabilityGrantsSchema } from "../services/mandates";

export { CapabilityGrantsSchema as ChatTaskGrantsSchema };

import { dates } from "@k2b/stdlib";
import { z } from "zod";
import { coreSettings } from "../services";
import { normalizeWorkflowSchedule } from "../workflows/runtime";
import type { AiChatTask, AiChatTaskOccurrence, AiChatTaskOccurrenceState, AiChatTaskSchedule, AiChatTaskState } from "./chat-tasks";
import { AI_SHORT_ID_PATTERN } from "./short-id";

export const ChatTaskIdSchema = z.string().regex(AI_SHORT_ID_PATTERN).describe("Readable six-character scheduled task ID.");
export const ChatTaskOccurrenceIdSchema = z.string().regex(AI_SHORT_ID_PATTERN).describe("Readable six-character task occurrence ID.");
export const AiConversationIdSchema = z.string().regex(AI_SHORT_ID_PATTERN).describe("Readable six-character AI conversation ID.");

export type AiChatTaskView = {
  nextRunAt?: string | null;
  id: string;
  chatId: string;
  chatTitle: string;
  grants: CapabilityGrant[];
  prompt: string;
  schedule: AiChatTaskSchedule;
  timezone: string;
  state: AiChatTaskState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiChatTaskOccurrenceView = {
  id: string;
  taskId: string;
  scheduledFor: string;
  trigger: "scheduled" | "manual";
  state: AiChatTaskOccurrenceState;
  error: string | null;
  resultText: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export const toAiChatTaskView = (task: AiChatTask): AiChatTaskView => ({
  id: task.shortId,
  chatId: task.chatId,
  chatTitle: task.chatTitle,
  grants: task.grants,
  prompt: task.prompt,
  schedule: task.schedule,
  timezone: task.timezone,
  state: task.state,
  lastError: task.lastError,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

export const toAiChatTaskOccurrenceView = (occurrence: AiChatTaskOccurrence, taskId: string): AiChatTaskOccurrenceView => ({
  id: occurrence.shortId,
  taskId,
  scheduledFor: occurrence.scheduledFor,
  trigger: occurrence.trigger,
  state: occurrence.state,
  error: occurrence.error,
  resultText: occurrence.resultText,
  createdAt: occurrence.createdAt,
  startedAt: occurrence.startedAt,
  completedAt: occurrence.completedAt,
});
export const ChatTaskScheduleInputSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("once").describe("Run once at a local wall-clock time."),
        localAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u, "Use YYYY-MM-DDTHH:mm")
          .describe("Exact local date and time in YYYY-MM-DDTHH:mm, interpreted in app.timezone."),
      })
      .strict(),
    z
      .object({
        kind: z.literal("cron").describe("Run repeatedly from a cron schedule."),
        cron: z.string().trim().min(1).max(120).describe("Five-field cron expression interpreted in app.timezone."),
      })
      .strict(),
  ])
  .describe("One-time or recurring schedule using the Cloud app timezone.");

export const getChatTaskTimezone = async (): Promise<string> =>
  dates.normalizeTimeZone(String((await coreSettings.get<string>("app.timezone")) || ""), "UTC");

export const chatTaskCreateFingerprint = (input: {
  chatId: string;
  prompt: string;
  schedule: z.infer<typeof ChatTaskScheduleInputSchema>;
  timezone?: string;
  grants?: CapabilityGrant[];
}): string =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([input.chatId, input.prompt.trim(), input.schedule, input.timezone ?? null, input.grants ?? []]))
    .digest("hex");

export const normalizeChatTaskSchedule = async (
  input: z.infer<typeof ChatTaskScheduleInputSchema>,
  timezoneInput?: string,
): Promise<{ schedule: AiChatTaskSchedule; timezone: string }> => {
  if (timezoneInput && !dates.isValidTimeZone(timezoneInput)) throw new Error("Invalid IANA timezone");
  const timezone = timezoneInput ? dates.normalizeTimeZone(timezoneInput) : await getChatTaskTimezone();
  if (input.kind === "cron") {
    const normalized = normalizeWorkflowSchedule({ cron: input.cron, timezone });
    return { schedule: { kind: "cron", cron: normalized.cron }, timezone: normalized.timezone };
  }
  const runAt = dates.zonedDateTimeToInstant(input.localAt, timezone, { disambiguation: "reject" });
  if (new Date(runAt).getTime() <= Date.now()) throw new Error("Scheduled time must be in the future");
  return { schedule: { kind: "once", runAt }, timezone };
};
