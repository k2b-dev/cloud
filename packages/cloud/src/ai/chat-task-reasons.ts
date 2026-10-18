import { dates, i18n } from "@k2b/stdlib";
import { canonicalLocale } from "../shared/locale";

export const CHAT_TASK_REASON_CODES = ["paused", "chat_archived", "owner_inactive", "failed", "rights_changed", "needs_approval"] as const;
export type ChatTaskReasonCode = (typeof CHAT_TASK_REASON_CODES)[number];
export type ChatTaskReason = { code: ChatTaskReasonCode; at: string; action?: string };

export const chatTaskReasonState = (code: ChatTaskReasonCode): "paused" | "needs_attention" => {
  switch (code) {
    case "paused":
    case "chat_archived":
    case "owner_inactive":
      return "paused";
    case "failed":
    case "rights_changed":
    case "needs_approval":
      return "needs_attention";
  }
};

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      paused: ({ time }: { time: string }) => `Paused by you on ${time}. What happens meanwhile is not caught up automatically.`,
      chat_archived: "Paused because the chat is archived.",
      owner_inactive: "Paused because the account is inactive.",
      failed: "The last run failed.",
      rights_changed: "What it may do changed. Please confirm again.",
      needs_approval: ({ action }: { action?: string }) =>
        `${action ? `Tried to ${action}. ` : ""}That needs your approval every time, and routines never ask.`,
      stopped: ({ list }: { list: string }) =>
        list
          ? `Stopped while the routine was running. Already done: ${list}. Nothing was undone.`
          : "Stopped while the routine was running. Nothing was undone.",
    },
    de: {
      paused: ({ time }) => `Von dir pausiert am ${time}. Was in der Pause passiert, wird nicht von selbst nachgeholt.`,
      chat_archived: "Pausiert, weil der Chat archiviert ist.",
      owner_inactive: "Pausiert, weil das Konto inaktiv ist.",
      failed: "Der letzte Lauf ist fehlgeschlagen.",
      rights_changed: "Was sie darf, hat sich geändert. Bitte neu bestätigen.",
      needs_approval: ({ action }) => `${action ? `Wollte ${action}. ` : ""}Das macht der Assistant nur mit dir, und Routinen fragen nie.`,
      stopped: ({ list }) =>
        list
          ? `Angehalten, während die Routine lief. Schon erledigt: ${list}. Nichts wurde rückgängig gemacht.`
          : "Angehalten, während die Routine lief. Nichts wurde rückgängig gemacht.",
    },
  },
});

/**
 * A one-time routine resumes only before its time: a run at that time already happened or was stopped, and what was
 * missed in a pause is not caught up. It needs a new time first.
 */
export const chatTaskNeedsNewTime = (
  task: {
    state: "active" | "paused" | "completed" | "needs_attention";
    schedule: { kind: "once"; runAt: string } | { kind: "cron"; cron: string };
  },
  now: Date = new Date(),
): boolean =>
  task.state !== "active" &&
  task.schedule.kind === "once" &&
  (task.state === "needs_attention" || Date.parse(task.schedule.runAt) <= now.getTime());

export const chatTaskLocale = (taskLocale: string | null | undefined, appLocale?: string | null): string =>
  canonicalLocale(taskLocale) ?? canonicalLocale(appLocale) ?? "en";

export const chatTaskReasonSentence = (reason: ChatTaskReason, context: { locale: string; timeZone: string }): string => {
  const t = messages.resolve([context.locale]).t;
  // The record is exhaustive: a new reason must have a sentence in both catalogs.
  const sentences: Record<ChatTaskReasonCode, () => string> = {
    paused: () => t.paused({ time: dates.formatDateTime(reason.at, context) }),
    chat_archived: () => t.chat_archived,
    owner_inactive: () => t.owner_inactive,
    failed: () => t.failed,
    rights_changed: () => t.rights_changed,
    needs_approval: () => t.needs_approval({ action: reason.action }),
  };
  return sentences[reason.code]();
};

export const chatTaskStopSentence = (done: readonly string[], locale: string): string =>
  messages.resolve([locale]).t.stopped({ list: done.map((item) => item.replace(/[.!?]+$/u, "")).join("; ") });
