import type { AiRoutes, AiWakeup, AiWakeupInput, AiWakeupPatch } from "@k2b/cloud/ai";
import { api } from "@k2b/cloud/browser";
import { dates, i18n } from "@k2b/stdlib";
import { Button, DatePicker, IconButton, LocaleProvider, prompts, Select, TextInput, toast } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { aiWakeupWhen } from "../wakeup-when";

/**
 * Gustav's alarms in a chat (Gustav alarms v1, 6): the list over the row above the field, the dialog that changes one,
 * and the actions of the lines. Loaded on first use, so the chat's own bundle carries none of it.
 */

/** What the chat lends its alarms: which chat, its alarms as the server listed them, and a fresh read. */
export type AssistantWakeupContext = {
  chatId: () => string | null;
  items: () => readonly AiWakeup[];
  limit: () => number;
  refresh: () => Promise<unknown>;
  locale: () => string;
  timeZone: string;
};

const words = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "Change alarm",
      count: ({ count, limit }: { count: number; limit: number }) => `${count} of ${limit}`,
      hint: "Gustav gets back to you here in the chat.",
      list: "Alarms in this chat",
      date: "Date",
      starts: "Starts on",
      time: "Time",
      repeat: "Repeat",
      ends: "Ends on",
      endsHint: "After 30 days at the latest. You can renew it then.",
      note: "Note for Gustav",
      noteHint: "Gustav reads this when the alarm rings.",
      never: "Never",
      daily: "Daily",
      workdays: "Weekdays (Mon to Fri)",
      weekly: ({ day }: { day: string }) => `Weekly on ${day}`,
      monthly: ({ day }: { day: number }) => `Monthly on day ${day}`,
      past: "This time has already passed. Choose a later time or another day.",
      timeWrong: "Enter a time such as 16:00.",
      noteWrong: "Write what Gustav should do then.",
      notSaved: ({ when }: { when: string }) => `Not saved. The alarm stays at ${when}.`,
      delete: "Delete",
      cancel: "Cancel",
      save: "Save",
      saving: "Saving …",
      retry: "Try again",
      edit: "Change alarm",
      remove: "Delete alarm",
      catchUp: "Catch up now",
      missed: "Missed",
      expired: "Expired",
      deleted: "Alarm deleted",
      undo: "Undo",
      failed: "That did not work. Try again.",
      failedTitle: "Alarm unchanged",
      resting: ({ count }: { count: number }) =>
        count === 1 ? "Its alarm pauses until you restore the chat:" : `Its ${count} alarms pause until you restore the chat:`,
    },
    de: {
      title: "Wecker ändern",
      count: ({ count, limit }: { count: number; limit: number }) => `${count} von ${limit}`,
      hint: "Gustav meldet sich dann hier im Chat.",
      list: "Wecker in diesem Chat",
      date: "Datum",
      starts: "Beginnt am",
      time: "Uhrzeit",
      repeat: "Wiederholen",
      ends: "Endet am",
      endsHint: "Spätestens nach 30 Tagen. Danach kannst du verlängern.",
      note: "Notiz für Gustav",
      noteHint: "Das liest Gustav, wenn der Wecker klingelt.",
      never: "Nie",
      daily: "Täglich",
      workdays: "Werktags (Mo bis Fr)",
      weekly: ({ day }: { day: string }) => `Wöchentlich am ${day}`,
      monthly: ({ day }: { day: number }) => `Monatlich am ${day}.`,
      past: "Diese Zeit ist schon vorbei. Wähle eine spätere Uhrzeit oder einen anderen Tag.",
      timeWrong: "Gib eine Uhrzeit wie 16:00 ein.",
      noteWrong: "Schreib, was Gustav dann tun soll.",
      notSaved: ({ when }: { when: string }) => `Nicht gespeichert. Der Wecker bleibt bei ${when}.`,
      delete: "Löschen",
      cancel: "Abbrechen",
      save: "Speichern",
      saving: "Speichert …",
      retry: "Erneut versuchen",
      edit: "Wecker ändern",
      remove: "Wecker löschen",
      catchUp: "Jetzt nachholen",
      missed: "Verpasst",
      expired: "Abgelaufen",
      deleted: "Wecker gelöscht",
      undo: "Rückgängig",
      failed: "Das hat nicht geklappt. Versuch es noch einmal.",
      failedTitle: "Wecker unverändert",
      resting: ({ count }: { count: number }) =>
        count === 1 ? "Sein Wecker ruht, bis du den Chat zurückholst:" : `Seine ${count} Wecker ruhen, bis du den Chat zurückholst:`,
    },
  },
});
const copy = (ctx: AssistantWakeupContext) => words.resolve([ctx.locale()]).t;

const DAY_MS = 86_400_000;
const client = api.create<AiRoutes>({ baseUrl: "/api/ai" });
const route = client.conversations[":conversationId"].wakeups;
/** Cloud refused a change and said why in the person's language, such as a stale revision or the limit of five. */
class WakeupRefused extends Error {}
const refused = async (response: Pick<Response, "json">): Promise<never> => {
  const body: unknown = await response.json().catch(() => null);
  throw body && typeof body === "object" && "message" in body && typeof body.message === "string"
    ? new WakeupRefused(body.message)
    : new Error();
};
/** Cloud's sentence for a refusal; any other failure gets the chat's own words, never a technical message. */
const reason = (error: unknown) => (error instanceof WakeupRefused ? error.message : null);
const wakeupApi = {
  create: async (chatId: string, input: AiWakeupInput) => {
    const response = await route.$post({ param: { conversationId: chatId }, json: input });
    if (!response.ok) await refused(response);
  },
  update: async (chatId: string, id: string, patch: AiWakeupPatch) => {
    const response = await route[":wakeupId"].$patch({ param: { conversationId: chatId, wakeupId: id }, json: patch });
    if (!response.ok) await refused(response);
  },
  remove: async (chatId: string, wakeup: AiWakeup) => {
    const response = await route[":wakeupId"].$delete({
      param: { conversationId: chatId, wakeupId: wakeup.id },
      json: { revision: wakeup.revision },
    });
    if (!response.ok) await refused(response);
  },
  catchUp: async (chatId: string, wakeup: AiWakeup) => {
    const response = await route[":wakeupId"]["catch-up"].$post({
      param: { conversationId: chatId, wakeupId: wakeup.id },
      json: { revision: wakeup.revision },
    });
    if (!response.ok) await refused(response);
  },
};

/**
 * Runs one change in the chat it was asked for and reads the chats again; a refusal says the server's sentence in a
 * toast, never silently.
 */
const change = async (ctx: AssistantWakeupContext, chatId: string | null, work: (chatId: string) => Promise<void>) => {
  if (!chatId) return false;
  try {
    await work(chatId);
    return true;
  } catch (error) {
    toast.error(reason(error) ?? copy(ctx).failed, { title: copy(ctx).failedTitle });
    return false;
  } finally {
    void ctx.refresh().catch(() => undefined);
  }
};

/** The same alarm set again, as "Undo" after a deletion and "Try again" for one Gustav could not set. */
const again = (wakeup: Pick<AiWakeup, "at" | "cron" | "timezone" | "endsAt" | "note">): AiWakeupInput => ({
  ...(wakeup.cron ? { cron: wakeup.cron } : {}),
  ...(wakeup.at ? { at: wakeup.at } : {}),
  ...(wakeup.cron && wakeup.endsAt ? { endsAt: wakeup.endsAt } : {}),
  timezone: wakeup.timezone,
  note: wakeup.note,
});

/** The cross deletes at once; the toast offers "Undo", which sets the same alarm again in the same chat. */
export const deleteWakeup = async (ctx: AssistantWakeupContext, wakeup: AiWakeup) => {
  const chatId = ctx.chatId();
  if (!(await change(ctx, chatId, (chat) => wakeupApi.remove(chat, wakeup)))) return;
  const t = copy(ctx);
  toast(t.deleted, {
    iconClass: "ti-alarm-off",
    action: { label: t.undo, variant: "ghost", onClick: () => void change(ctx, chatId, (chat) => wakeupApi.create(chat, again(wakeup))) },
  });
};
export const catchUpWakeup = (ctx: AssistantWakeupContext, wakeup: AiWakeup) =>
  change(ctx, ctx.chatId(), (chat) => wakeupApi.catchUp(chat, wakeup));
/** A repeating alarm that ran out runs for another 30 days, by the server's own clock. */
export const renewWakeup = (ctx: AssistantWakeupContext, wakeup: AiWakeup) =>
  change(ctx, ctx.chatId(), (chat) => wakeupApi.update(chat, wakeup.id, { revision: wakeup.revision, endsAt: null }));
export const retryWakeup = (ctx: AssistantWakeupContext, input: AiWakeupInput) =>
  change(ctx, ctx.chatId(), (chat) =>
    wakeupApi.create(
      chat,
      again({ at: input.at ?? null, cron: input.cron ?? null, timezone: input.timezone, endsAt: input.endsAt ?? null, note: input.note }),
    ),
  );

/** One action of a line or the box on an alarm the chat lists now. */
export const actOnWakeup = async (
  ctx: AssistantWakeupContext,
  action: "edit" | "delete" | "renew" | "catch-up",
  wakeup: AiWakeup,
): Promise<void> => {
  if (action === "edit") await editWakeup(ctx, wakeup);
  else if (action === "delete") await deleteWakeup(ctx, wakeup);
  else if (action === "renew") await renewWakeup(ctx, wakeup);
  else await catchUpWakeup(ctx, wakeup);
};

/** A rhythm the dialog offers by name, or Gustav's own one, which it keeps as it is. */
type Repeat = "never" | "daily" | "workdays" | "weekly" | "monthly" | "custom";
const repeatOf = (cron: string | null): Repeat => {
  if (!cron) return "never";
  const [minute, hour, day, month, weekday] = cron.split(" ");
  if (!/^\d+$/.test(minute ?? "") || !/^\d+$/.test(hour ?? "") || month !== "*") return "custom";
  if (day === "*" && weekday === "*") return "daily";
  if (day === "*" && weekday === "1-5") return "workdays";
  if (day === "*" && /^[0-6]$/.test(weekday ?? "")) return "weekly";
  if (/^\d+$/.test(day ?? "") && weekday === "*") return "monthly";
  return "custom";
};
const cronOf = (repeat: Repeat, date: string, time: string): string | null => {
  const [hour, minute] = time.split(":").map(Number);
  const day = new Date(`${date}T12:00:00Z`);
  if (repeat === "daily") return `${minute} ${hour} * * *`;
  if (repeat === "workdays") return `${minute} ${hour} * * 1-5`;
  if (repeat === "weekly") return `${minute} ${hour} * * ${day.getUTCDay()}`;
  if (repeat === "monthly") return `${minute} ${hour} ${day.getUTCDate()} * *`;
  return null;
};

/** "Change alarm": a small dialog on a computer, a sheet on a phone. Nothing applies before "Save". */
function WakeupDialog(props: { ctx: AssistantWakeupContext; wakeup: AiWakeup; close: () => void; guard: (handler: () => void) => void }) {
  const t = () => copy(props.ctx);
  // The alarm's own time zone: its rhythm and its times keep their meaning, whoever looks at them.
  const zone = props.wakeup.timezone;
  const locale = props.ctx.locale();
  // The chat the dialog opened in, also if the person moves on meanwhile.
  const chatId = props.ctx.chatId();
  /** The alarm as the chat lists it now, so "Try again" after a change elsewhere uses its newest revision. */
  const latest = () => props.ctx.items().find((item) => item.id === props.wakeup.id) ?? props.wakeup;
  const startAt = props.wakeup.at ?? new Date(Date.now() + 3_600_000).toISOString();
  const local = dates.instantToZonedInput(startAt, zone);
  const initialRepeat = repeatOf(props.wakeup.cron);
  const lastEnd = dates.instantToZonedInput(new Date(Date.now() + 30 * DAY_MS - 60_000), zone).slice(0, 10);
  const [date, setDate] = createSignal<string | null>(local.slice(0, 10));
  const [time, setTime] = createSignal(local.slice(11, 16));
  const [timeWrong, setTimeWrong] = createSignal(false);
  /** "16:00", "16.00", "1600" and "9:30" read as a time of day; anything else asks for one. */
  const clock = () => {
    const match = /^(\d{1,2})[:.]?(\d{2})$/.exec(time().trim());
    const hour = Number(match?.[1]);
    const minute = Number(match?.[2]);
    return match && hour < 24 && minute < 60 ? `${String(hour).padStart(2, "0")}:${match[2]}` : null;
  };
  const [repeat, setRepeat] = createSignal<Repeat>(initialRepeat);
  // An alarm that ran out starts again with the longest end; otherwise its own end stands.
  const initialEnd =
    props.wakeup.endsAt && Date.parse(props.wakeup.endsAt) > Date.now()
      ? dates.instantToZonedInput(props.wakeup.endsAt, zone).slice(0, 10)
      : lastEnd;
  const [end, setEnd] = createSignal<string | null>(initialEnd);
  const [note, setNote] = createSignal(props.wakeup.note);
  const [noteWrong, setNoteWrong] = createSignal(false);
  const [past, setPast] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);
  let timeField: HTMLDivElement | undefined;
  props.guard(() => {
    if (!busy()) props.close();
  });
  const weekday = () =>
    new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(`${date() ?? local.slice(0, 10)}T12:00:00Z`));
  const repeatLabel = (value: Repeat) =>
    value === "never"
      ? t().never
      : value === "daily"
        ? t().daily
        : value === "workdays"
          ? t().workdays
          : value === "weekly"
            ? t().weekly({ day: weekday() })
            : value === "monthly"
              ? t().monthly({ day: Number((date() ?? local).slice(8, 10)) })
              : props.wakeup.rhythm;
  const options = () =>
    (["never", "daily", "workdays", "weekly", "monthly", ...(initialRepeat === "custom" ? ["custom" as const] : [])] as const).map(
      (id) => ({ id, label: repeatLabel(id) }),
    );
  const atIso = (key: string) => {
    try {
      return dates.zonedDateTimeToInstant(`${key}T${clock()}`, zone, { disambiguation: "later" });
    } catch {
      return null;
    }
  };
  /** "What changes", over the foot, without a box: time and rhythm, before and after. */
  const day = (key: string) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(
      new Date(`${key}T12:00:00Z`),
    );
  const changes = () => [
    ...(date() && date() !== local.slice(0, 10) ? [{ label: t().date, from: day(local.slice(0, 10)), to: day(date()!) }] : []),
    ...(clock() && clock() !== local.slice(11, 16) ? [{ label: t().time, from: local.slice(11, 16), to: clock()! }] : []),
    ...(repeat() !== initialRepeat ? [{ label: t().repeat, from: repeatLabel(initialRepeat), to: repeatLabel(repeat()) }] : []),
  ];
  /** A weekday rhythm that would start on a weekend starts on the Monday after. */
  const firstDay = (key: string) => {
    const weekday = new Date(`${key}T12:00:00Z`).getUTCDay();
    const skip = repeat() === "workdays" ? (weekday === 6 ? 2 : weekday === 0 ? 1 : 0) : 0;
    return skip ? new Date(Date.parse(`${key}T12:00:00Z`) + skip * DAY_MS).toISOString().slice(0, 10) : key;
  };
  const save = async (event: Event) => {
    event.preventDefault();
    if (!chatId || busy()) return;
    const text = note().trim();
    if (!text) {
      setNoteWrong(true);
      return;
    }
    const recurring = repeat() !== "never";
    const timeChanged = date() !== local.slice(0, 10) || clock() !== local.slice(11, 16);
    // A named rhythm is rebuilt from day and time; Gustav's own rhythm stays and only its next time may move.
    const cron = repeat() === "custom" ? undefined : recurring ? cronOf(repeat(), firstDay(date() ?? ""), clock() ?? "") : null;
    const sendAt = repeat() !== "custom" || timeChanged;
    const at = sendAt && clock() && date() ? (atIso(firstDay(date()!)) ?? null) : undefined;
    if (sendAt && (!at || Date.parse(at) <= Date.now())) {
      setTimeWrong(!clock());
      setPast(Boolean(clock()));
      timeField?.querySelector("input")?.focus();
      return;
    }
    // A new end, or the longest one (the server's own 30 days) for a renewed or newly repeating alarm.
    const endChanged = end() !== initialEnd || props.wakeup.status === "expired" || !props.wakeup.cron;
    const endsAt =
      !recurring || !endChanged
        ? undefined
        : end() === lastEnd || !end()
          ? null
          : dates.zonedDateTimeToInstant(`${end()}T23:59`, zone, { disambiguation: "later" });
    const patch = {
      ...(at ? { at } : {}),
      ...(cron !== undefined && cron !== props.wakeup.cron ? { cron } : {}),
      ...(endsAt !== undefined ? { endsAt } : {}),
      ...(text !== props.wakeup.note ? { note: text } : {}),
    };
    if (Object.keys(patch).length === 0) return props.close();
    setBusy(true);
    setFailed(null);
    try {
      await wakeupApi.update(chatId, props.wakeup.id, { revision: latest().revision, ...patch });
      void props.ctx.refresh().catch(() => undefined);
      props.close();
    } catch (error) {
      setFailed(reason(error) ?? "");
      // A change elsewhere moved the revision on: the next try uses the newest one.
      void props.ctx.refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <LocaleProvider locale={locale}>
      <form class="assistant-wakeup-dialog" onSubmit={(event) => void save(event)}>
        <div class="assistant-wakeup-dialog__pair">
          <DatePicker
            label={repeat() === "never" ? t().date : t().starts}
            value={date}
            onValueChange={(value) => {
              setDate(value);
              setPast(false);
            }}
            dateConfig={{ timeZone: zone }}
            disabled={busy()}
          />
          <div ref={timeField}>
            <TextInput
              label={t().time}
              value={time()}
              inputMode="numeric"
              maxLength={5}
              placeholder="16:00"
              onValueChange={(value) => {
                setTime(value);
                setPast(false);
                setTimeWrong(false);
              }}
              error={past() ? t().past : timeWrong() ? t().timeWrong : undefined}
              disabled={busy()}
            />
          </div>
        </div>
        <Select
          label={t().repeat}
          value={repeat()}
          options={options()}
          onValueChange={(value) => setRepeat(options().find((option) => option.id === value)?.id ?? "never")}
          disabled={busy()}
        />
        <Show when={repeat() !== "never"}>
          <DatePicker
            label={t().ends}
            description={t().endsHint}
            value={end}
            onValueChange={setEnd}
            max={lastEnd}
            dateConfig={{ timeZone: zone }}
            disabled={busy()}
          />
        </Show>
        <TextInput
          label={t().note}
          multiline
          lines={2}
          maxLength={200}
          value={note()}
          onValueChange={(value) => {
            setNote(value ?? "");
            setNoteWrong(false);
          }}
          error={noteWrong() ? t().noteWrong : undefined}
          description={
            <span class="assistant-wakeup-dialog__hint">
              <span>{t().noteHint}</span>
              <span class="assistant-wakeup-dialog__count">{[...note()].length} / 200</span>
            </span>
          }
          disabled={busy()}
        />
        <Show
          when={failed() === null}
          fallback={
            <p class="assistant-wakeup-dialog__error" role="alert">
              <i class="ti ti-alert-circle" aria-hidden="true" />
              <span>
                {t().notSaved({ when: aiWakeupWhen(props.wakeup, { locale, timeZone: zone, lower: true }) })} {failed()}
              </span>
            </p>
          }
        >
          <Show when={changes().length}>
            <p class="assistant-wakeup-dialog__changes">
              <span>
                <For each={changes()}>
                  {(change, index) => (
                    <>
                      {index() ? " · " : ""}
                      {change.label}: {change.from} → <b>{change.to}</b>
                    </>
                  )}
                </For>
              </span>
            </p>
          </Show>
        </Show>
        <footer class="assistant-wakeup-dialog__foot">
          <Button
            variant="ghost"
            class="assistant-wakeup-dialog__delete"
            disabled={busy()}
            onClick={() => {
              props.close();
              void deleteWakeup(props.ctx, props.wakeup);
            }}
          >
            <i class="ti ti-trash" aria-hidden="true" />
            {t().delete}
          </Button>
          <span class="assistant-wakeup-dialog__grow" />
          <Button variant="ghost" disabled={busy()} onClick={() => props.close()}>
            {t().cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={busy()} loading={busy()}>
            {busy() ? t().saving : failed() === null ? t().save : t().retry}
          </Button>
        </footer>
      </form>
    </LocaleProvider>
  );
}

export const editWakeup = (ctx: AssistantWakeupContext, wakeup: AiWakeup) =>
  prompts.dialog<void>(
    (close, context) => (
      <WakeupDialog ctx={ctx} wakeup={wakeup} close={() => close()} guard={(handler) => context.setDismissHandler(handler)} />
    ),
    { title: copy(ctx).title, size: "medium", history: true },
  );

/**
 * The list over the row (form of "Queued", v6): time in a fixed column, the note behind it, and two fixed places for
 * pencil and cross on the row under the pointer or with focus; on phones always, with time and note on two lines. A
 * missed one-off offers "Catch up now" in the pencil's place.
 */
export function WakeupList(props: {
  id: string;
  ctx: AssistantWakeupContext;
  root: () => HTMLElement | undefined;
  onClose: (focus: boolean) => void;
}) {
  const t = () => copy(props.ctx);
  const zone = { locale: props.ctx.locale(), timeZone: props.ctx.timeZone };
  createEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape in the dialog over the list closes only the dialog.
      if (event.key !== "Escape" || event.defaultPrevented || (event.target instanceof Element && event.target.closest("dialog"))) return;
      event.preventDefault();
      props.onClose(true);
    };
    const onPointer = (event: PointerEvent) => {
      const root = props.root();
      const target = event.target;
      // A press in the dialog or a toast the list opened keeps it.
      if (root && target instanceof Element && !root.contains(target) && !target.closest("dialog, .k2b-toast")) props.onClose(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    });
  });
  // The last alarm gone closes the list and gives the focus back to the row.
  createEffect(() => {
    if (props.ctx.items().length === 0) props.onClose(true);
  });
  return (
    <div class="assistant-queue__list assistant-wakeups__list" id={props.id} role="group" aria-label={t().list}>
      <div class="assistant-queue__list-head">
        <span>
          {aiWakeupWordsHead(props.ctx.locale())} ·{" "}
          <span class="assistant-queue__count">{t().count({ count: props.ctx.items().length, limit: props.ctx.limit() })}</span>
        </span>
        <span class="assistant-queue__hint">{t().hint}</span>
      </div>
      <ol class="assistant-queue__rows">
        <For each={props.ctx.items()}>
          {(wakeup) => (
            <li class="assistant-queue__row assistant-wakeups__row k2b-progressive-row" data-entry={wakeup.id}>
              <i
                class={`assistant-queue__sign assistant-wakeups__sign ${wakeup.cron ? "ti ti-repeat" : "ti ti-alarm"}`}
                aria-hidden="true"
              />
              <span class="assistant-queue__main assistant-wakeups__main">
                <span class="assistant-wakeups__when">{aiWakeupWhen(wakeup, zone)}</span>
                <span class="assistant-queue__text" title={wakeup.note}>
                  {wakeup.note}
                </span>
              </span>
              <Show when={wakeup.status === "missed" || wakeup.status === "expired"}>
                <span class="assistant-wakeups__state">
                  <i class="ti ti-alert-triangle" aria-hidden="true" />
                  {wakeup.status === "missed" ? t().missed : t().expired}
                </span>
              </Show>
              <span class="assistant-queue__actions assistant-wakeups__actions k2b-progressive-action">
                <Show
                  when={wakeup.status === "missed" && !wakeup.cron}
                  fallback={
                    <IconButton size="sm" label={t().edit} onClick={() => void editWakeup(props.ctx, wakeup)}>
                      <i class="ti ti-pencil" aria-hidden="true" />
                    </IconButton>
                  }
                >
                  <IconButton size="sm" label={t().catchUp} onClick={() => void catchUpWakeup(props.ctx, wakeup)}>
                    <i class="ti ti-send" aria-hidden="true" />
                  </IconButton>
                </Show>
                <IconButton size="sm" label={t().remove} onClick={() => void deleteWakeup(props.ctx, wakeup)}>
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </span>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

/** For the archive dialog: the chat's alarms, which rest while it is archived, one per line; empty without any. */
export const restingWakeups = async (chatId: string, locale: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) => {
  // The archive dialog never waits long for them: without an answer in three seconds it opens without the list.
  const response = await route.$get({ param: { conversationId: chatId } }, { init: { signal: AbortSignal.timeout(3000) } });
  if (!response.ok) return "";
  const { items } = await response.json();
  return items.length
    ? [
        words.resolve([locale]).t.resting({ count: items.length }),
        ...items.map((item) => `${aiWakeupWhen(item, { locale, timeZone })} · ${item.note}`),
      ].join("\n")
    : "";
};

const aiWakeupWordsHead = (locale: string) => (locale.startsWith("de") ? "Wecker" : "Alarms");
