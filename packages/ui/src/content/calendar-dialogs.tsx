import { createSignal, For, Show } from "solid-js";
import { dialogCore } from "../feedback/dialog-core";
import { DialogHeader } from "../feedback/prompts";
import type { CalendarCommand } from "./Calendar";
import { addDayKeys } from "./calendar-days";
import type { CalendarMessages } from "./calendar-messages";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The keys of a shortcut as the reader presses them, such as ["⇧", "N"] or ["Shift", "N"]. */
export const shortcutKeys = (shortcut: string): string[] => {
  const mac = isMac();
  const names: Record<string, string> = {
    shift: mac ? "⇧" : "Shift",
    alt: mac ? "⌥" : "Alt",
    ctrl: mac ? "⌃" : "Ctrl",
    meta: mac ? "⌘" : "Meta",
    mod: mac ? "⌘" : "Ctrl",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
  };
  return shortcut.split("+").map((part) => names[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part));
};

/**
 * The calendar's shortcuts: the same list the host registers for its dispatcher and its help. `alternatives` names
 * other keys the calendar itself handles for a command, such as the arrow keys that page like J and K.
 */
export const openCalendarShortcuts = (
  commands: readonly CalendarCommand[],
  messages: CalendarMessages,
  alternatives: Readonly<Record<string, string>> = {},
) =>
  dialogCore.open<void>(
    (close) => (
      <div class="k2b-dialog__panel">
        <DialogHeader title={messages.calendarShortcuts} icon="ti ti-keyboard" close={() => close()} />
        <div class="k2b-dialog__body">
          <dl class="k2b-calendar-shortcuts">
            <For each={commands.filter((command) => command.shortcut)}>
              {(command) => (
                <>
                  <dt>
                    <For each={shortcutKeys(command.shortcut!)}>{(key) => <kbd class="k2b-calendar-shortcuts__key">{key}</kbd>}</For>
                    <Show when={alternatives[command.id]}>
                      {(other) => (
                        <>
                          <span class="k2b-calendar-shortcuts__or">/</span>
                          <For each={shortcutKeys(other())}>{(key) => <kbd class="k2b-calendar-shortcuts__key">{key}</kbd>}</For>
                        </>
                      )}
                    </Show>
                  </dt>
                  <dd>{command.label}</dd>
                </>
              )}
            </For>
          </dl>
          <p class="k2b-calendar-shortcuts__note">{messages.calendarShortcutsNote}</p>
        </div>
      </div>
    ),
    { panelClassName: "k2b-dialog k2b-dialog--small", ariaLabel: messages.calendarShortcuts },
  );

const pad = (value: number) => String(value).padStart(2, "0");
const validKey = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${pad(month)}-${pad(day)}`
    : null;
};
/** The Monday of an ISO week of a year. */
const isoWeekStart = (year: number, week: number) => {
  const january4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(january4.getTime() - ((january4.getUTCDay() || 7) - 1) * 86_400_000);
  return addDayKeys(monday.toISOString().slice(0, 10), (week - 1) * 7);
};

/**
 * Reads German and English dates, weekdays, months, week numbers, today, and tomorrow for Go to. Weekdays include
 * today unless preceded by next; a month alone uses the next year if it has passed. A date without a year is this
 * year's. Names ignore case and accents and allow a trailing dot. Returns a `YYYY-MM-DD` key or `null`.
 */
export const parseGoTo = (text: string, today: string): string | null => {
  const value = text.trim().toLowerCase();
  if (!value) return null;
  const year = Number(today.slice(0, 4));
  if (/^(heute|today)$/.test(value)) return today;
  if (/^(morgen|tomorrow)$/.test(value)) return addDayKeys(today, 1);
  const fullYear = (raw: string | undefined) => (raw ? (raw.length === 2 ? 2000 + Number(raw) : Number(raw)) : year);
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (match) return validKey(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\.(\d{1,2})\.?(\d{2}|\d{4})?$/.exec(value);
  if (match) return validKey(fullYear(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(value);
  if (match) return validKey(fullYear(match[3]), Number(match[1]), Number(match[2]));
  match = /^(?:kw|w|week|woche)\s*(\d{1,2})(?:\s*\/?\s*(\d{4}))?$/.exec(value);
  if (match) {
    const week = Number(match[1]);
    return week >= 1 && week <= 53 ? isoWeekStart(match[2] ? Number(match[2]) : year, week) : null;
  }
  const named = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\.$/, "")
    .trim();
  const weekdays = [
    "montag mo monday mon",
    "dienstag di tuesday tue tues",
    "mittwoch mi wednesday wed",
    "donnerstag do thursday thu thur thurs",
    "freitag fr friday fri",
    "samstag sa saturday sat",
    "sonntag so sunday sun",
  ];
  match = /^(?:(am|on|nachste|nachsten|nachster|naechsten|kommende|kommenden|next)\s+)?([a-z]+)$/.exec(named);
  if (match) {
    const name = match[2];
    const weekday = weekdays.findIndex((names) => names.split(" ").includes(name ?? ""));
    if (weekday >= 0) {
      const date = new Date(Date.UTC(year, Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10))));
      const todayWeekday = (date.getUTCDay() + 6) % 7;
      let diff = (weekday - todayWeekday + 7) % 7;
      if (match[1] && match[1] !== "am" && match[1] !== "on" && diff === 0) diff = 7;
      return addDayKeys(today, diff);
    }
  }
  const months = [
    "januar jan january",
    "februar feb february",
    "marz maerz mar mrz march",
    "april apr",
    "mai may",
    "juni jun june",
    "juli jul july",
    "august aug",
    "september sep sept",
    "oktober okt october oct",
    "november nov",
    "dezember dez december dec",
  ];
  const monthOf = (name: string | undefined) => months.findIndex((names) => names.split(" ").includes(name ?? "")) + 1;
  match = /^(\d{1,2})\.?\s+([a-z]+)\.?(?:\s+(\d{4}))?$/.exec(named);
  if (match) return validKey(fullYear(match[3]), monthOf(match[2]), Number(match[1]));
  match = /^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(named);
  if (match) return validKey(fullYear(match[3]), monthOf(match[1]), Number(match[2]));
  match = /^([a-z]+)\.?(?:\s+(\d{4}))?$/.exec(named);
  if (match) {
    const month = monthOf(match[1]);
    const monthYear = match[2] ? Number(match[2]) : year + (month < Number(today.slice(5, 7)) ? 1 : 0);
    return validKey(monthYear, month, 1);
  }
  return null;
};

/** Go to: a field that reads a date or a week number and names the day it found before the reader goes there. */
export const openCalendarGoTo = (props: {
  messages: CalendarMessages;
  today: string;
  describe: (key: string) => string;
  onGo: (key: string) => void;
}) =>
  dialogCore
    .open<string>(
      (close) => {
        const [text, setText] = createSignal("");
        const result = () => parseGoTo(text(), props.today);
        return (
          <form
            class="k2b-dialog__panel"
            onSubmit={(event) => {
              event.preventDefault();
              const key = result();
              if (key) close(key);
            }}
          >
            <DialogHeader title={props.messages.calendarCommandGoTo} icon="ti ti-calendar-search" close={() => close()} />
            <div class="k2b-dialog__body k2b-calendar-goto">
              <input
                class="k2b-calendar-goto__input"
                type="text"
                autocomplete="off"
                spellcheck={false}
                aria-label={props.messages.calendarCommandGoTo}
                aria-describedby="k2b-calendar-goto-hint"
                placeholder={props.messages.calendarGoToPlaceholder}
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
              />
              <p class="k2b-calendar-goto__preview" id="k2b-calendar-goto-hint" aria-live="polite" data-ok={result() ? "true" : undefined}>
                <Show when={result()} fallback={text().trim() ? props.messages.calendarGoToUnknown : props.messages.calendarGoToHint}>
                  {(key) => `→ ${props.describe(key())}`}
                </Show>
              </p>
            </div>
            <footer class="k2b-dialog__actions">
              <button type="submit" class="k2b-button" data-variant="primary" data-size="sm" disabled={!result()}>
                {props.messages.calendarGoToGo}
              </button>
            </footer>
          </form>
        );
      },
      { panelClassName: "k2b-dialog k2b-dialog--small", ariaLabel: props.messages.calendarCommandGoTo, initialFocus: "first-input" },
    )
    .then((key) => {
      if (key) props.onGo(key);
    });
