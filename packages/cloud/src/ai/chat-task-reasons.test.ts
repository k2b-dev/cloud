import { describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import {
  CHAT_TASK_REASON_CODES,
  type ChatTaskReasonCode,
  chatTaskLocale,
  chatTaskNeedsNewTime,
  chatTaskReasonSentence,
  chatTaskReasonState,
  chatTaskStopSentence,
} from "./chat-task-reasons";

const at = "2026-04-07T13:45:00.000Z";
const expected: Record<"en" | "de", Record<ChatTaskReasonCode, string>> = {
  en: {
    paused: `Paused by you on ${dates.formatDateTime(at, { locale: "en", timeZone: "Europe/Berlin" })}. What happens meanwhile is not caught up automatically.`,
    chat_archived: "Paused because the chat is archived.",
    owner_inactive: "Paused because the account is inactive.",
    failed: "The last run failed.",
    rights_changed: "What it may do changed. Please confirm again.",
    needs_approval: "That needs your approval every time, and routines never ask.",
  },
  de: {
    paused: `Von dir pausiert am ${dates.formatDateTime(at, { locale: "de", timeZone: "Europe/Berlin" })}. Was in der Pause passiert, wird nicht von selbst nachgeholt.`,
    chat_archived: "Pausiert, weil der Chat archiviert ist.",
    owner_inactive: "Pausiert, weil das Konto inaktiv ist.",
    failed: "Der letzte Lauf ist fehlgeschlagen.",
    rights_changed: "Was sie darf, hat sich geändert. Bitte neu bestätigen.",
    needs_approval: "Das macht der Assistant nur mit dir, und Routinen fragen nie.",
  },
};
describe("routine reason sentences", () => {
  for (const locale of ["de", "en"] as const)
    for (const code of CHAT_TASK_REASON_CODES) {
      test(`${locale}: ${code}`, () => {
        expect(chatTaskReasonSentence({ code, at }, { locale, timeZone: "Europe/Berlin" })).toBe(expected[locale][code]);
        expect(chatTaskReasonState(code)).toBe(["paused", "chat_archived", "owner_inactive"].includes(code) ? "paused" : "needs_attention");
      });
    }
  test("optional approval action", () => {
    expect(chatTaskReasonSentence({ code: "needs_approval", at, action: "send mail" }, { locale: "en", timeZone: "UTC" })).toBe(
      `Tried to send mail. ${expected.en.needs_approval}`,
    );
    expect(chatTaskReasonSentence({ code: "needs_approval", at, action: "eine Mail senden" }, { locale: "de", timeZone: "UTC" })).toBe(
      `Wollte eine Mail senden. ${expected.de.needs_approval}`,
    );
  });
  test("stop frame with and without completed writes", () => {
    expect(chatTaskStopSentence([], "de")).toBe("Angehalten, während die Routine lief. Nichts wurde rückgängig gemacht.");
    expect(chatTaskStopSentence([], "en")).toBe("Stopped while the routine was running. Nothing was undone.");
    expect(chatTaskStopSentence(["Rechnung gespeichert."], "de")).toBe(
      "Angehalten, während die Routine lief. Schon erledigt: Rechnung gespeichert. Nichts wurde rückgängig gemacht.",
    );
    expect(chatTaskStopSentence(["Saved invoice", "Sent mail"], "en")).toBe(
      "Stopped while the routine was running. Already done: Saved invoice; Sent mail. Nothing was undone.",
    );
  });
  test("locale order and canonical tags", () => {
    expect(chatTaskLocale("DE-ch", "en")).toBe("de-CH");
    expect(chatTaskLocale(null, "DE")).toBe("de");
    expect(chatTaskLocale(null, null)).toBe("en");
    expect(chatTaskLocale("invalid_locale", "de")).toBe("de");
  });

  test("a one-time routine needs a new time once its time has passed", () => {
    const now = new Date("2026-10-17T09:00:00.000Z");
    const once = (runAt: string) => ({ kind: "once" as const, runAt });
    expect(chatTaskNeedsNewTime({ state: "paused", schedule: once("2026-10-18T09:00:00.000Z") }, now)).toBe(false);
    expect(chatTaskNeedsNewTime({ state: "paused", schedule: once("2026-10-16T09:00:00.000Z") }, now)).toBe(true);
    expect(chatTaskNeedsNewTime({ state: "needs_attention", schedule: once("2026-10-18T09:00:00.000Z") }, now)).toBe(true);
    expect(chatTaskNeedsNewTime({ state: "active", schedule: once("2026-10-16T09:00:00.000Z") }, now)).toBe(false);
    expect(chatTaskNeedsNewTime({ state: "paused", schedule: { kind: "cron", cron: "0 9 * * *" } }, now)).toBe(false);
  });
});
