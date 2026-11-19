import type { AiWakeup } from "@k2b/cloud/ai";
import type { AiWakeupInput } from "@k2b/cloud/ai/browser";
import type { AiWakeupLineInput } from "@k2b/cloud/ai/ui";
import { i18n } from "@k2b/stdlib";
import { aiWakeupDay, aiWakeupWhen } from "../wakeup-when";

/**
 * Gustav's alarm lines in words (Gustav alarms v1, 6). The server writes them for the first frame; afterwards the chat
 * loads this module and writes them itself, so its static bundle carries no words or rules of the lines.
 */
export const aiWakeupWords = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      alarm: "Alarm",
      moved: "Alarm postponed",
      renewed: "Alarm renewed",
      caughtUp: "Alarm caught up",
      notSet: "Alarm not set",
      expired: "Alarm expired",
      deleted: "Deleted",
      missedOne: ({ when }: { when: string }) => `Alarm ${when} did not run.`,
      before: ({ when }: { when: string }) => `before ${when}`,
      snoozes: ({ count }: { count: number }) => `postponed ${count} of 3 times`,
      ends: ({ day }: { day: string }) => `ends ${day}`,
      until: ({ day }: { day: string }) => `until ${day}`,
      after30: "after 30 days",
      access: "You had no access to Gustav.",
      budget: "The daily limit for turns without you is reached.",
      queue_full: "Too many messages were already waiting in this chat.",
      delivery: "Cloud could not deliver it.",
      stays: "The alarm stays.",
      next: "The alarm runs again at its next time.",
      edit: "Change alarm",
      remove: "Delete alarm",
      retry: "Try again",
      catchUp: "Catch up now",
      renew: "Renew for 30 days",
      head: "Alarms",
      missed: "Missed",
      expiredWord: "Expired",
      show: ({ count }: { count: number }) => (count > 1 ? `Show all ${count} alarms` : "Show the alarm"),
    },
    de: {
      alarm: "Wecker",
      moved: "Wecker verschoben",
      renewed: "Wecker verlängert",
      caughtUp: "Wecker nachgeholt",
      notSet: "Wecker nicht gestellt",
      expired: "Wecker abgelaufen",
      deleted: "Gelöscht",
      missedOne: ({ when }: { when: string }) => `Wecker ${when} nicht gelaufen.`,
      before: ({ when }: { when: string }) => `vorher ${when}`,
      snoozes: ({ count }: { count: number }) => `${count}. von 3 Verschiebungen`,
      ends: ({ day }: { day: string }) => `endet ${day}`,
      until: ({ day }: { day: string }) => `bis ${day}`,
      after30: "nach 30 Tagen",
      access: "Du hattest keinen Zugriff auf Gustav.",
      budget: "Das Tageslimit für Züge ohne dich ist erreicht.",
      queue_full: "In diesem Chat warteten schon zu viele Nachrichten.",
      delivery: "Cloud konnte ihn nicht zustellen.",
      stays: "Der Wecker bleibt stehen.",
      next: "Der Wecker läuft beim nächsten Termin wieder.",
      edit: "Wecker ändern",
      remove: "Wecker löschen",
      retry: "Erneut versuchen",
      catchUp: "Jetzt nachholen",
      renew: "Um 30 Tage verlängern",
      head: "Wecker",
      missed: "Verpasst",
      expiredWord: "Abgelaufen",
      show: ({ count }: { count: number }) => (count > 1 ? `Alle ${count} Wecker zeigen` : "Wecker zeigen"),
    },
  },
});

/** One alarm line as text, ready to draw and to send from the server. */
export type AssistantWakeupLineText = {
  kind?: "missed" | "expired" | "failed";
  sign: string;
  struck?: boolean;
  verb: string;
  body: string;
  aside?: string;
  state?: string;
  /** The one way out: renew, catch up, or set the alarm Gustav could not set. */
  link?: { label: string; action: "renew" | "catch-up" | "retry"; id?: string; input?: AiWakeupInput };
  /** Pencil and cross for the newest line of an alarm the chat still has. */
  acts?: { id: string; edit: string; remove: string };
};

/** Writes one line; `current` are the chat's alarms now, without which the line is history only. */
export const describeWakeupLine = (
  line: AiWakeupLineInput,
  input: { locale: string; timeZone: string; current: readonly AiWakeup[] | undefined },
): AssistantWakeupLineText => {
  const t = aiWakeupWords.resolve([input.locale]).t;
  const zone = { locale: input.locale, timeZone: input.timeZone, lower: true };
  if (line.failed) {
    const tried = line.failed.input;
    // A repeating alarm Gustav could not set has no rhythm in words yet; the line names its note only.
    const when = aiWakeupWhen({ at: tried.cron ? null : (tried.at ?? null), cron: null, rhythm: "" }, zone);
    return {
      kind: "failed",
      sign: "ti-alert-circle",
      verb: t.notSet,
      body: `${when ? ` · ${when}` : ""} · ${tried.note}`,
      ...(input.current && !line.failed.retried ? { link: { label: t.retry, action: "retry" as const, input: tried } } : {}),
    };
  }
  const { event, previous, latest, deleted } = line.plan;
  const w = event.wakeup;
  const kind = event.kind;
  const live = latest ? input.current?.find((item) => item.id === w.id) : undefined;
  const when = aiWakeupWhen(w, zone);
  if (kind === "missed" || kind === "expired") {
    const link =
      live?.status === "expired" && live.cron
        ? { label: t.renew, action: "renew" as const, id: live.id }
        : live?.status === "missed" && !live.cron
          ? { label: t.catchUp, action: "catch-up" as const, id: live.id }
          : undefined;
    const reason = w.missedReason;
    return {
      kind,
      sign: "ti-alarm-off",
      ...(kind === "expired"
        ? { verb: t.expired, body: ` ${w.cron ? `${t.after30} · ` : ""}${when} · ${w.note}` }
        : {
            verb: t.missedOne({ when }),
            body: ` ${reason ? `${t[reason]} ` : ""}${w.cron ? t.next : t.stays}`,
          }),
      ...(link ? { link } : {}),
    };
  }
  const struck = deleted || kind === "deleted";
  const renewed = kind === "updated" && previous?.status === "expired" && w.status === "active";
  const moved = kind === "updated" && previous !== undefined && w.snoozes > previous.snoozes;
  const before = kind === "updated" && previous && !renewed && !moved ? aiWakeupWhen(previous, zone) : when;
  return {
    sign: struck ? "ti-alarm-off" : w.cron ? "ti-repeat" : "ti-alarm",
    struck,
    verb: kind === "caught_up" ? t.caughtUp : renewed ? t.renewed : moved ? t.moved : t.alarm,
    body: ` · ${when} · ${w.note}`,
    aside:
      (moved ? ` (${t.snoozes({ count: w.snoozes })})` : before !== when ? ` (${t.before({ when: before })})` : "") +
      (w.cron && w.endsAt && !struck ? ` · ${(renewed ? t.until : t.ends)({ day: aiWakeupDay(w.endsAt, zone) })}` : ""),
    ...(struck ? { state: t.deleted } : {}),
    ...(!struck && kind !== "caught_up" && live ? { acts: { id: live.id, edit: t.edit, remove: t.remove } } : {}),
  };
};
