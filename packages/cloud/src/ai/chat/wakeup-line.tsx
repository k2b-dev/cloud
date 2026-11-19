import { i18n } from "@k2b/stdlib";
import { IconButton } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import type { AiMessageTimelineItem } from "../timeline";
import type { AiWakeup, AiWakeupEvent, AiWakeupInput } from "../wakeup-contracts";
import { aiWakeupDay, aiWakeupWhen } from "../wakeup-when";

/** What a host lends the alarm lines of its chat: the current alarms and the ways to act on them. */
export type AiChatWakeupHost = {
  /** The chat's alarms as the server lists them now; a line acts only on an alarm listed here. */
  current: () => readonly AiWakeup[] | undefined;
  onEdit: (wakeup: AiWakeup) => void;
  onDelete: (wakeup: AiWakeup) => void;
  onCatchUp: (wakeup: AiWakeup) => void;
  onRenew: (wakeup: AiWakeup) => void;
  /** Sets an alarm Gustav could not set, from the time and note he tried. */
  onRetry: (input: AiWakeupInput) => void;
};

export const aiWakeupWords = i18n.define({
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
      delivery: "Cloud could not deliver it. Change its time to try again.",
      stays: "The alarm stays.",
      next: "It tries again at its next time.",
      edit: "Change alarm",
      remove: "Delete alarm",
      retry: "Try again",
      catchUp: "Catch up now",
      renew: "Renew for 30 days",
      planned: ({ time }: { time: string }) => `planned ${time}, delayed`,
      head: "Alarms",
      missed: "Missed",
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
      delivery: "Cloud konnte ihn nicht zustellen. Ändere die Zeit, um es erneut zu versuchen.",
      stays: "Der Wecker bleibt stehen.",
      next: "Er versucht es beim nächsten Termin wieder.",
      edit: "Wecker ändern",
      remove: "Wecker löschen",
      retry: "Erneut versuchen",
      catchUp: "Jetzt nachholen",
      renew: "Um 30 Tage verlängern",
      planned: ({ time }: { time: string }) => `geplant ${time}, verspätet`,
      head: "Wecker",
      missed: "Verpasst",
      show: ({ count }: { count: number }) => (count > 1 ? `Alle ${count} Wecker zeigen` : "Wecker zeigen"),
    },
  },
});

/** How one alarm line reads: the fact, the alarm before it, and whether it is the alarm's newest line. */
export type AiWakeupLinePlan = {
  event: AiWakeupEvent;
  /** The same alarm in the line before, for "before 16:00" and "postponed". */
  previous?: AiWakeup;
  /** Only an alarm's newest line offers actions; older lines are history. */
  latest: boolean;
  /** The person deleted the alarm here: the line stays, struck through. */
  deleted: boolean;
};

const sameAlarm = (a: AiWakeup, b: AiWakeup) => a.at === b.at && a.cron === b.cron && a.endsAt === b.endsAt && a.note === b.note;

/**
 * One plan per alarm line of the chat, by timeline item. The person's deletion strikes the alarm's line through in
 * place instead of adding one; their "Undo" right after it sets the same alarm again and the line stands as before.
 */
export const planAiWakeupLines = (items: readonly AiMessageTimelineItem[]): Map<string, AiWakeupLinePlan> => {
  const plans = new Map<string, AiWakeupLinePlan>();
  const newest = new Map<string, AiWakeupLinePlan>();
  let undoable: AiWakeupLinePlan | null = null;
  for (const item of items) {
    const event = item.type === "wakeup" ? item.entry.meta?.wakeupEvent : undefined;
    if (!event || item.type !== "wakeup") {
      undoable = null;
      continue;
    }
    const before = newest.get(event.wakeup.id);
    const person = item.loopId === null;
    if (person && event.kind === "deleted" && before) {
      before.deleted = true;
      undoable = before;
      continue;
    }
    if (person && event.kind === "created" && undoable && sameAlarm(undoable.event.wakeup, event.wakeup)) {
      undoable.deleted = false;
      undoable.event = { ...undoable.event, wakeup: event.wakeup };
      newest.set(event.wakeup.id, undoable);
      undoable = null;
      continue;
    }
    undoable = null;
    if (before) before.latest = false;
    const plan: AiWakeupLinePlan = { event, ...(before ? { previous: before.event.wakeup } : {}), latest: true, deleted: false };
    plans.set(item.id, plan);
    newest.set(event.wakeup.id, plan);
  }
  return plans;
};

type Line = {
  kind?: "notice" | "failed";
  sign: string;
  struck?: boolean;
  verb: string;
  body: string;
  aside?: string;
  state?: string;
  link?: { label: string; run: () => void };
  /** The alarm the pencil and the cross act on. */
  acts?: AiWakeup;
};

const describe = (props: Parameters<typeof AiWakeupLine>[0]): Line => {
  const t = aiWakeupWords.resolve([props.locale]).t;
  const zone = { locale: props.locale, timeZone: props.timeZone, lower: true };
  const host = props.host;
  if (props.failed) {
    const input = props.failed.input;
    // A repeating alarm Gustav could not set has no rhythm in words yet; the line names its note only.
    const when = aiWakeupWhen({ at: input.cron ? null : (input.at ?? null), cron: null, rhythm: "" }, zone);
    return {
      kind: "failed",
      sign: "ti-alert-circle",
      verb: t.notSet,
      body: `${when ? ` · ${when}` : ""} · ${input.note}`,
      link: host && !props.failed.retried ? { label: t.retry, run: () => host.onRetry(input) } : undefined,
    };
  }
  const { event, previous, latest, deleted } = props.plan!;
  const w = event.wakeup;
  const kind = event.kind;
  const live = latest ? host?.current()?.find((item) => item.id === w.id) : undefined;
  const when = aiWakeupWhen(w, zone);
  if (kind === "missed" || kind === "expired") {
    const link =
      host && live?.status === "expired" && live.cron
        ? { label: t.renew, run: () => host.onRenew(live) }
        : host && live?.status === "missed" && !live.cron
          ? { label: t.catchUp, run: () => host.onCatchUp(live) }
          : undefined;
    const reason = w.missedReason;
    return kind === "expired"
      ? { kind: "notice", sign: "ti-alarm-off", verb: t.expired, body: ` ${w.cron ? `${t.after30} · ` : ""}${when} · ${w.note}`, link }
      : {
          kind: "notice",
          sign: "ti-alarm-off",
          verb: t.missedOne({ when }),
          body: ` ${reason ? `${t[reason]} ` : ""}${reason === "delivery" ? "" : w.cron ? t.next : t.stays}`,
          link,
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
    state: struck ? t.deleted : undefined,
    acts: !struck && kind !== "caught_up" ? live : undefined,
  };
};

/**
 * Alarm facts as lines without a box, on the edge of Gustav's work line (Gustav alarms v1, 6): sign in plum, "Alarm ·
 * time · note", 13 px. Pencil and cross only on the newest line of an alarm the chat still has; a missed or expired
 * alarm says why in one sentence with one way out; an alarm Gustav could not set offers "Try again". None of these
 * lines cost a model call.
 */
export function AiWakeupLine(props: {
  plan?: AiWakeupLinePlan;
  failed?: { input: AiWakeupInput; retried: boolean };
  host?: AiChatWakeupHost;
  locale: string;
  timeZone: string;
}) {
  const line = createMemo(() => describe(props));
  const t = () => aiWakeupWords.resolve([props.locale]).t;
  return (
    <span class="ai-wakeup-line k2b-progressive-row" data-kind={line().kind} data-struck={line().struck ? "" : undefined}>
      <i class={`ai-wakeup-line__sign ti ${line().sign}`} aria-hidden="true" />
      <span class="ai-wakeup-line__text">
        <b>{line().verb}</b>
        {line().body}
        <span class="ai-wakeup-line__aside">{line().aside}</span>
      </span>
      <Show when={line().state}>
        <span class="ai-wakeup-line__state">{line().state}</span>
      </Show>
      <Show when={line().link}>
        {(link) => (
          <button type="button" class="ai-wakeup-line__link" onClick={() => link().run()}>
            {link().label}
          </button>
        )}
      </Show>
      <Show when={line().acts}>
        {(wakeup) => (
          <span class="ai-wakeup-line__acts k2b-progressive-action">
            <IconButton size="xs" variant="ghost" label={t().edit} tooltip={t().edit} onClick={() => props.host?.onEdit(wakeup())}>
              <i class="ti ti-pencil" aria-hidden="true" />
            </IconButton>
            <IconButton size="xs" variant="ghost" label={t().remove} tooltip={t().remove} onClick={() => props.host?.onDelete(wakeup())}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          </span>
        )}
      </Show>
    </span>
  );
}
