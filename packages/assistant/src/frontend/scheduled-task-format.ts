import type { AiChatTaskView as AssistantChatTask } from "@k2b/cloud/ai";
import { dates } from "@k2b/stdlib";

export const assistantTaskTitle = (task: AssistantChatTask) => task.prompt.split(/\n|:\s/u)[0]!.slice(0, 80);
export const formatAssistantTaskSchedule = (task: AssistantChatTask, locale = "en"): string => {
  if (task.schedule.kind === "once") return locale.startsWith("de") ? "Einmalig" : "One-time";
  const [minute, hour, day, month, weekday] = task.schedule.cron.split(" ");
  const de = locale.startsWith("de");
  if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "") && day === "*" && month === "*") {
    const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
    const weekdays = de
      ? ["Sonntags", "Montags", "Dienstags", "Mittwochs", "Donnerstags", "Freitags", "Samstags", "Sonntags"]
      : ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
    const label =
      weekday === "*"
        ? de
          ? "Täglich"
          : "Daily"
        : weekday === "1-5"
          ? de
            ? "Montag–Freitag"
            : "Monday–Friday"
          : /^\d$/.test(weekday ?? "")
            ? weekdays[Number(weekday)]
            : null;
    if (label) return `${de ? (weekday === "*" ? "Täglich" : "Immer " + label.toLowerCase()) : label} ${time}`;
  }
  return de ? "Wiederkehrend" : "Recurring";
};

/** Schedule wording inside a sentence; the dialog keeps its existing standalone wording. */
export const formatAssistantTaskScheduleInline = (task: AssistantChatTask, locale = "en"): string => {
  const de = locale.startsWith("de");
  if (task.schedule.kind === "once")
    return `${de ? "am" : "on"} ${dates.formatDateTime(task.schedule.runAt, { locale, timeZone: task.timezone })}`;
  const [minute, hour, day, month, weekday] = task.schedule.cron.split(" ");
  if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "") && day === "*" && month === "*") {
    const time = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
    const weekdays = de
      ? ["sonntags", "montags", "dienstags", "mittwochs", "donnerstags", "freitags", "samstags", "sonntags"]
      : ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
    const label =
      weekday === "*"
        ? de
          ? "täglich"
          : "daily"
        : weekday === "1-5"
          ? de
            ? "Montag bis Freitag"
            : "Monday to Friday"
          : /^\d$/.test(weekday ?? "")
            ? weekdays[Number(weekday)]
            : null;
    if (label) return `${label} ${time}`;
  }
  return de ? "wiederkehrend" : "recurring";
};
