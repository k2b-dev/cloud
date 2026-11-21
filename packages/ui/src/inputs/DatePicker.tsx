import { type DateContext, dates } from "@k2b/stdlib";
import { batch, createEffect, createMemo, createRoot, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { Dynamic, isServer } from "solid-js/web";
import { prefersMenuSheet } from "../actions/phone-sheet";
import { readDialogCall } from "../feedback/dialog-call";
import { createFieldMeta, Field, fieldControlAria, fieldDescribedBy } from "../internal/field";
import { returnFocus, ringOnReturn } from "../internal/focus-return";
import { useDateConfigLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { type DateInputResult, dateInputPattern, formatDateInput, parseDateInput } from "./date-input";
import { resolveDateInputMessages } from "./date-input-messages";
import {
  type DateStatusTone,
  draftStatusText,
  errorText,
  formatDateLong,
  limitErrorText,
  rangeStatusText,
  restStatusText,
  spokenDateText,
  typingStatusText,
} from "./date-input-status";
import {
  type DateRangeValue,
  dateKey,
  displayDate,
  draftDateTimeValue,
  filterTimeInput,
  formatDateOnlyRangeDuration,
  formatDateTimeValue,
  isCompleteTime,
  isDateKey,
  normalizeTimeInput,
  parseDateValue,
  pickRangeDay,
  previewRange,
  rangeAnchor,
  splitDateTime,
  toDateTimeValue,
} from "./date-picker";
import type { FieldSuggestionProps, MaybeAccessor, ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import { useFieldSuggestion } from "./field-suggestion-slot";
import type { ChoiceAppearance } from "./Select";

export type { DateRangeValue } from "./date-picker";

export type DatePreset<T> = {
  label: string;
  value: T;
};

export type DurationPreset = {
  label: string;
  minutes: number;
};

export type DatePickerBaseProps<T> = Omit<ValueFieldProps<T>, "value"> & {
  placeholder?: string;
  value: MaybeAccessor<T>;
  presets?: readonly DatePreset<T>[];
  dateConfig?: DateContext;
  clearable?: boolean;
  /**
   * `field` (default) is a text field: people type a date or open the calendar. `plain` shows the value as text for
   * property rows and only opens the calendar; a clearable plain picker offers clearing in its panel.
   */
  appearance?: ChoiceAppearance;
  /** Earliest selectable day as a date key such as `2026-11-02`; earlier days are locked and typed ones refused. */
  min?: string;
  /** Latest selectable day as a date key. */
  max?: string;
  /** Shows and announces the value without changing it; the field stays focusable. */
  readOnly?: boolean;
};

export type DatePickerProps = DatePickerBaseProps<string | null> &
  /** A suggested day is a date key such as `2026-10-28`; only the default `field` appearance shows it. */
  FieldSuggestionProps<string> & {
    /** Content for a set value: the trigger of a `plain` picker, or the resting status line of a typed field. */
    renderValue?: (value: string) => JSX.Element;
  };
export type DateTimePickerProps = DatePickerBaseProps<string | null> & {
  /** Trigger content for a set value, for example the date and time with a relative hint. */
  renderValue?: (value: string) => JSX.Element;
  /**
   * The time is optional: the value is a date key such as `2026-10-24` until **Add time** adds one, then a date-time
   * like without this option. Removing the time returns to the date key.
   */
  optionalTime?: boolean;
  /** The time a new value starts with, `09:00` by default. */
  defaultTime?: string;
};
export type DateRangePickerProps = DatePickerBaseProps<DateRangeValue> & {
  withTime?: boolean;
  datePresets?: readonly DatePreset<string | null>[];
  durationPresets?: readonly DurationPreset[];
};

const popoverIsOpen = (popover: HTMLElement | undefined): boolean => {
  if (!popover) return false;
  try {
    return popover.matches(":popover-open");
  } catch {
    return false;
  }
};

/** `below` is a line under the trigger that the panel must not cover, such as a typed field's status line. */
export const placeDatePopover = (trigger: HTMLElement, popover: HTMLElement, wide: boolean, below?: HTMLElement): void => {
  const margin = 8;
  const gap = 4;
  const triggerRect = trigger.getBoundingClientRect();
  const belowRect = below?.getBoundingClientRect();
  const rect = {
    left: triggerRect.left,
    top: triggerRect.top,
    bottom: Math.max(triggerRect.bottom, belowRect?.height ? belowRect.bottom : 0),
  };
  // Keep the panel at its designed width instead of stretching to a full-width
  // trigger; it only ever shrinks to fit a narrow viewport.
  const preferredWidth = wide ? 440 : 336;
  const width = Math.min(preferredWidth, window.innerWidth - margin * 2);
  popover.style.width = `${width}px`;

  const popoverRect = popover.getBoundingClientRect();
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
  const roomBelow = window.innerHeight - rect.bottom - gap - margin;
  const roomAbove = rect.top - gap - margin;
  const opensAbove = popoverRect.height > roomBelow && roomAbove > roomBelow;
  const top = opensAbove
    ? Math.max(margin, rect.top - popoverRect.height - gap)
    : Math.min(rect.bottom + gap, window.innerHeight - popoverRect.height - margin);

  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(margin, top)}px`;
};

function PickerShell<T>(props: {
  owner: DatePickerBaseProps<T>;
  icon: string;
  valueLabel: () => string;
  valueContent?: () => JSX.Element;
  children: (close: () => void) => JSX.Element;
  clearValue: T;
  onOpen?: () => void;
  footerMeta?: () => JSX.Element;
  wide?: boolean;
  timezone?: string;
}): JSX.Element {
  onMount(() => {
    void preloadDatePickerPanel();
  });
  const messages = useUiMessages();
  const meta = createFieldMeta(props.owner.id);
  const [open, setOpen] = createSignal(false);
  const error = () => resolveMaybeAccessor(props.owner.error);
  let trigger: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  let triggerRing = true;

  const place = () => {
    if (trigger && popover && open()) placeDatePopover(trigger, popover, props.wide ?? false);
  };

  const close = () => {
    // Before hiding, so the popover does not return focus on its own.
    if (popover?.contains(document.activeElement)) returnFocus(trigger, triggerRing);
    if (popoverIsOpen(popover)) popover?.hidePopover();
    setOpen(false);
  };

  const show = () => {
    if (props.owner.disabled || !popover || popoverIsOpen(popover)) return;
    props.onOpen?.();
    triggerRing = ringOnReturn(trigger);
    popover.showPopover();
    setOpen(true);
    void preloadDatePickerPanel().then(() => {
      place();
      const initial =
        popover?.querySelector<HTMLElement>('[data-date-focus="true"]') ??
        popover?.querySelector<HTMLElement>('[data-date-day]:not([data-outside="true"])');
      initial?.focus();
    });
  };

  const toggle = () => (open() ? close() : show());
  const plain = () => props.owner.appearance === "plain";
  const canClear = () => Boolean(props.owner.clearable && props.valueLabel() && !props.owner.disabled);
  const clear = () => {
    close();
    commitFieldValue(props.owner, props.clearValue);
    trigger?.focus();
  };

  onMount(() => {
    const syncOpenState = () => setOpen(popoverIsOpen(popover));
    popover?.addEventListener("toggle", syncOpenState);
    onCleanup(() => popover?.removeEventListener("toggle", syncOpenState));
  });

  createEffect(() => {
    if (!open()) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    onCleanup(() => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    });
  });
  onCleanup(close);

  return (
    <Field
      class={props.owner.class}
      label={props.owner.label}
      description={props.owner.description}
      error={error()}
      required={props.owner.required}
      disabled={props.owner.disabled}
      meta={meta}
    >
      <div class="k2b-date-picker" data-appearance={props.owner.appearance ?? "field"} data-invalid={error() ? "true" : undefined}>
        <button
          ref={trigger}
          id={meta.controlId}
          type="button"
          class="k2b-date-trigger"
          data-placeholder={props.valueLabel() ? undefined : "true"}
          data-open={open() ? "true" : undefined}
          disabled={props.owner.disabled}
          aria-haspopup="dialog"
          aria-expanded={open()}
          aria-controls={`${meta.controlId}-popover`}
          {...fieldControlAria(meta, props.owner)}
          // A button's name replaces its content, so the shown date reaches assistive technology as the description.
          aria-describedby={[fieldDescribedBy(meta, props.owner), `${meta.controlId}-value`].filter(Boolean).join(" ")}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              show();
            }
          }}
        >
          <i class={`${props.icon} k2b-date-trigger__icon`} aria-hidden="true" />
          <span id={`${meta.controlId}-value`} class="k2b-date-trigger__value">
            <Show when={props.valueLabel()} fallback={props.owner.placeholder ?? messages().pickDate}>
              {props.valueContent?.() ?? props.valueLabel()}
            </Show>
          </span>
          <i class="ti ti-chevron-down k2b-date-trigger__chevron" aria-hidden="true" />
        </button>

        <Show when={canClear() && !plain()}>
          <button
            type="button"
            class="k2b-date-trigger__clear k2b-input-clear-action"
            aria-label={messages().clearDate}
            onClick={(event) => {
              event.stopPropagation();
              clear();
            }}
          >
            <i class="ti ti-x" aria-hidden="true" />
          </button>
        </Show>

        <div
          ref={popover}
          id={`${meta.controlId}-popover`}
          class="k2b-date-popover"
          popover="auto"
          role="dialog"
          aria-label={typeof props.owner.label === "string" ? props.owner.label : messages().datePicker}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            close();
          }}
          onToggle={(event) => {
            const nextOpen = event.newState === "open";
            setOpen(nextOpen);
            if (nextOpen) queueMicrotask(place);
          }}
        >
          {props.children(close)}
          <Show when={props.footerMeta || props.timezone || (plain() && canClear())}>
            <footer class="k2b-date-popover__footer">
              <span>{props.footerMeta?.()}</span>
              {/* A plain trigger has no room for a clear button beside its value. */}
              <Show when={plain() && canClear()}>
                <button type="button" class="k2b-date-popover__clear" onClick={clear}>
                  <i class="ti ti-x" aria-hidden="true" />
                  {messages().clearDate}
                </button>
              </Show>
              <Show when={props.timezone}>
                <span class="k2b-date-popover__timezone">
                  <i class="ti ti-world" aria-hidden="true" />
                  {props.timezone}
                </span>
              </Show>
            </footer>
          </Show>
        </div>
      </div>
    </Field>
  );
}

function PresetRail<T>(props: { presets?: readonly DatePreset<T>[]; onSelect: (value: T) => void }): JSX.Element {
  const messages = useUiMessages();
  return (
    <Show when={props.presets?.length}>
      <aside class="k2b-date-presets" aria-label={messages().datePresets}>
        <For each={props.presets}>
          {(preset) => (
            <button type="button" onClick={() => props.onSelect(preset.value)}>
              {preset.label}
            </button>
          )}
        </For>
      </aside>
    </Show>
  );
}

type DatePickerPanelProps = Parameters<typeof import("./date-picker-panel")["DatePickerPanel"]>[0];
type PanelModule = typeof import("./date-picker-panel");
/**
 * The month panel loads apart from the field (`date-picker-panel.tsx`), as the field first shows in the browser: a
 * page carries the field up front and the calendar once it is on screen. A signal rather than `lazy`, so a Suspense
 * boundary of the page never shows its fallback. The server renders no month panel: every calendar is a closed
 * popover there, and an island renders again in the browser.
 *
 * The promise settles once the panel can render, so a calendar opened in the moment before places itself and moves
 * focus when its days exist.
 */
const [loadedPanel, setLoadedPanel] = createRoot(() => createSignal<PanelModule["DatePickerPanel"]>());
let panelLoad: Promise<unknown> | undefined;
export const preloadDatePickerPanel = (): Promise<unknown> => {
  if (panelLoad) return panelLoad;
  panelLoad = import("./date-picker-panel").then(
    (module) => setLoadedPanel(() => module.DatePickerPanel),
    (error: unknown) => {
      // The next field tries again.
      panelLoad = undefined;
      globalThis.reportError(error);
    },
  );
  return panelLoad;
};

/** One month of days. Exported for composite pickers in this package (the period picker shows two side by side). */
export function DatePickerPanel(props: DatePickerPanelProps): JSX.Element {
  if (!isServer) void preloadDatePickerPanel();
  return <Show when={loadedPanel()}>{(Panel) => <Dynamic component={Panel()} {...props} />}</Show>;
}

function TimeInput(props: { time: string; onChange: (time: string) => void; label?: string }): JSX.Element {
  const messages = useUiMessages();
  return (
    <label class="k2b-date-time">
      <Show when={props.label}>
        <span>{props.label}</span>
      </Show>
      <span class="k2b-date-time__control">
        <input
          type="text"
          inputMode="numeric"
          value={props.time}
          placeholder="09:00"
          onInput={(event) => props.onChange(filterTimeInput(event.currentTarget.value))}
          onBlur={() => props.onChange(normalizeTimeInput(props.time))}
          aria-label={props.label ? messages().timeLabel({ label: props.label }) : messages().time}
        />
        <i class="ti ti-clock" aria-hidden="true" />
      </span>
    </label>
  );
}

/** The calendar popover of a typed field: it lives inside the field's shell, so focus in the calendar keeps the field's focus edge. */
function createCalendarPopover(options: {
  anchor: () => HTMLElement | undefined;
  below: () => HTMLElement | undefined;
  wide: () => boolean;
}) {
  const [open, setOpen] = createSignal(false);
  let popover: HTMLDivElement | undefined;
  const place = () => {
    const anchor = options.anchor();
    if (anchor && popover && open()) placeDatePopover(anchor, popover, options.wide(), options.below());
  };
  const show = () => {
    if (!popover || popoverIsOpen(popover)) return;
    setOpen(true);
    popover.showPopover();
    place();
    // A calendar opened before its panel arrived places itself again around the days.
    void preloadDatePickerPanel().then(place);
  };
  const close = () => {
    if (popoverIsOpen(popover)) popover?.hidePopover();
    setOpen(false);
  };
  createEffect(() => {
    if (!open()) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    onCleanup(() => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    });
  });
  onCleanup(close);
  return {
    open,
    show,
    close,
    place,
    ref: (element: HTMLDivElement) => {
      popover = element;
      // The browser also hides a popover itself, for example when it leaves the top layer.
      element.addEventListener("toggle", () => setOpen(popoverIsOpen(element)));
    },
    element: () => popover,
    focusDay: () => void preloadDatePickerPanel().then(() => popover?.querySelector<HTMLElement>('[data-date-focus="true"]')?.focus()),
  };
}

/** The day an empty calendar opens on: today, moved inside min/max, so a limited field never opens on locked months only. */
const openingDay = (value: string | null | undefined, limits: { min?: string; max?: string }, context: DateContext): string => {
  if (value) return value;
  const today = dateKey(new Date(), context);
  if (limits.min && today < limits.min) return limits.min;
  if (limits.max && today > limits.max) return limits.max;
  return today;
};

const fieldName = (owner: { label?: JSX.Element; "aria-label"?: string }): string | undefined =>
  typeof owner.label === "string" ? owner.label : owner["aria-label"];

/** Clicks on the calendar's empty space keep focus where it is, so the draft and caret stay in the text. */
const keepFocus = (event: PointerEvent) => {
  if (!(event.target as Element).closest("button")) event.preventDefault();
};

const caretToEnd = (input: HTMLInputElement | undefined) => {
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
};

function DateStatusLine(props: {
  id: string;
  tone: DateStatusTone;
  text: JSX.Element;
  announcement: string;
  ref?: (element: HTMLElement) => void;
}) {
  return (
    <>
      {/* Always one line, also when empty, so typing, a mistake or a cleared value never move what follows. */}
      <p
        ref={props.ref}
        id={props.id}
        class="k2b-date-status"
        data-tone={props.tone}
        title={typeof props.text === "string" && props.text ? props.text : undefined}
      >
        {props.text}
      </p>
      <span class="k2b-sr-only" aria-live="polite">
        {props.announcement}
      </span>
    </>
  );
}

/**
 * The typed date field. The text and the calendar always show the same day: typing moves the calendar, picking a day
 * fills the text, and the status line says which day the text means before it is committed.
 */
function DateTextField(props: { owner: DatePickerProps; value: () => string | null; dateConfig: () => DateContext }): JSX.Element {
  // The calendar is on hand when the field first opens it.
  onMount(() => {
    void preloadDatePickerPanel();
  });
  const uiMessages = useUiMessages();
  const meta = createFieldMeta(props.owner.id);
  const locale = () => props.dateConfig().locale;
  const t = createMemo(() => resolveDateInputMessages(locale()));
  const today = () => dateKey(new Date(), props.dateConfig());
  const format = (key: string | null | undefined) => (key ? formatDateInput(key, locale()) : "");
  const limits = () => ({ min: props.owner.min, max: props.owner.max });
  const interactive = () => !props.owner.disabled && !props.owner.readOnly;
  const [text, setText] = createSignal(format(props.value()));
  const [dirty, setDirty] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();
  const [announcement, setAnnouncement] = createSignal("");
  const [visibleMonth, setVisibleMonth] = createSignal(
    parseDateValue(openingDay(props.value(), limits(), props.dateConfig()), props.dateConfig()),
  );
  let shell: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let toggle: HTMLButtonElement | undefined;
  let statusLine: HTMLElement | undefined;
  const [sheetOpen, setSheetOpen] = createSignal(false);
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const calendar = createCalendarPopover({
    anchor: () => shell,
    below: () => statusLine,
    wide: () => Boolean(props.owner.presets?.length),
  });
  const popoverId = `${meta.controlId}-calendar`;
  const sheetId = `${meta.controlId}-sheet`;
  // The status line holds the field's message slot, so it carries the `<id>-error` every field family uses.
  const statusId = meta.errorId;

  const parse = (value: string): DateInputResult => parseDateInput(value, { today: today(), locale: locale() });
  const parsed = createMemo(() => (dirty() ? parse(text()) : undefined));
  const draftKey = () => {
    const result = parsed();
    if (!result) return props.value();
    return result.kind === "date" ? result.date : null;
  };

  // A value set from outside replaces the text, unless someone is typing.
  createEffect(
    on([props.value, locale], () => {
      if (dirty()) return;
      setText(format(props.value()));
      setFailure(undefined);
      setVisibleMonth(parseDateValue(openingDay(props.value(), limits(), props.dateConfig()), props.dateConfig()));
    }),
  );
  // The calendar follows the typed day, and a refused text stops being red once it means an allowed day.
  createEffect(
    on(parsed, (result) => {
      if (result?.kind === "date") {
        setVisibleMonth(parseDateValue(result.date, props.dateConfig()));
        if (!limitErrorText(result.date, limits(), locale(), t())) setFailure(undefined);
      } else if (result?.kind === "empty") setFailure(undefined);
    }),
  );
  onCleanup(() => clearTimeout(announceTimer));

  const externalError = () => resolveMaybeAccessor(props.owner.error);
  const invalid = () => Boolean(failure() || externalError());
  const suggestion = useFieldSuggestion({
    props: props.owner,
    meta,
    value: props.value,
    format,
  });
  const status = createMemo((): { tone: DateStatusTone; text: JSX.Element } => {
    const failed = failure();
    if (failed) return { tone: "error", text: failed };
    const result = parsed();
    if (result?.kind === "date") {
      const limit = limitErrorText(result.date, limits(), locale(), t());
      return limit ? { tone: "rest", text: limit } : { tone: "draft", text: draftStatusText(result.date, result.note, locale(), t()) };
    }
    if (result?.kind === "error") return { tone: "rest", text: typingStatusText(result.error, locale(), t(), today()) };
    const external = externalError();
    if (external) return { tone: "error", text: external };
    const value = props.value();
    // With a suggestion the line shares the label row and speaks only while typing or on an error.
    if (!value || result || suggestion.enabled) return { tone: "rest", text: "" };
    return { tone: "rest", text: props.owner.renderValue?.(value) ?? restStatusText(value, today(), locale()) };
  });

  const save = (next: string | null) => {
    if (next !== props.value()) commitFieldValue(props.owner, next);
  };
  const fail = (message: string) => {
    setFailure(message);
    setAnnouncement(message);
  };
  /** Enter, leaving the field and a picked day commit; a refused text stays for correction and the value is kept. */
  const commit = () => {
    const result = parse(text());
    setDirty(false);
    if (result.kind === "empty") {
      if (props.owner.required) return fail(t().required);
      setFailure(undefined);
      return save(null);
    }
    if (result.kind === "error") return fail(errorText(result.error, locale(), t(), today()));
    const limit = limitErrorText(result.date, limits(), locale(), t());
    if (limit) return fail(limit);
    setFailure(undefined);
    setText(format(result.date));
    save(result.date);
  };
  const restore = () => {
    setText(format(props.value()));
    setDirty(false);
    setFailure(undefined);
    setVisibleMonth(parseDateValue(openingDay(props.value(), limits(), props.dateConfig()), props.dateConfig()));
    calendar.close();
  };
  const pick = (key: string | null) => {
    setText(format(key));
    setDirty(false);
    setFailure(undefined);
    save(key);
    calendar.close();
  };

  const openSheet = async () => {
    setSheetOpen(true);
    calendar.close();
    // The sheet opens with the context of this tap, not of the moment its code arrives.
    const call = readDialogCall(shell);
    const { openDateSheet } = await import("./date-sheet");
    await openDateSheet<string>(call, {
      title: props.owner.label ?? props.owner["aria-label"],
      subtitle: props.value() ? formatDateLong(props.value()!, locale()) : t().noDate,
      ariaLabel: fieldName(props.owner),
      id: sheetId,
      locale: locale() ?? "en",
      content: (close) => (
        <DatePickerPanel
          visibleMonth={visibleMonth}
          setVisibleMonth={setVisibleMonth}
          selected={draftKey}
          focusDate={draftKey}
          onSelect={(key) => {
            // Saved at once: the sheet's promise settles only after its history entry has gone.
            pick(key);
            close(key);
          }}
          dateConfig={props.dateConfig()}
          min={props.owner.min}
          max={props.owner.max}
        />
      ),
    });
    setSheetOpen(false);
    toggle?.focus({ preventScroll: true });
  };
  /** Phones open the calendar as a sheet; there the text only brings up the keypad. */
  const openCalendar = (focusDay: boolean) => {
    if (!interactive()) return;
    if (prefersMenuSheet()) return void openSheet();
    if (!dirty()) setVisibleMonth(parseDateValue(openingDay(props.value(), limits(), props.dateConfig()), props.dateConfig()));
    calendar.show();
    if (focusDay) calendar.focusDay();
  };

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Element;
    if (!interactive() || calendar.element()?.contains(target) || target.closest(".k2b-date-field__clear")) return;
    const onIcon = target.closest(".k2b-date-field__toggle, .k2b-date-field__icon");
    if (prefersMenuSheet()) {
      if (onIcon) {
        event.preventDefault();
        void openSheet();
      }
      return;
    }
    if (onIcon) {
      event.preventDefault();
      input?.focus();
      if (calendar.open()) calendar.close();
      else openCalendar(false);
      return;
    }
    // A pointer in the text opens the calendar and keeps the caret; Tab focus never opens it.
    if (event.button === 0 && !calendar.open()) setTimeout(() => openCalendar(false));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // A refused text keeps Enter too, so it does not submit the form around it.
    if (event.key === "Enter" && (dirty() || calendar.open() || failure())) {
      event.preventDefault();
      commit();
      calendar.close();
    } else if (event.key === "Escape" && (dirty() || calendar.open() || failure())) {
      event.preventDefault();
      event.stopPropagation();
      restore();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      openCalendar(true);
    } else if (event.key === "ArrowUp" && event.altKey) {
      event.preventDefault();
      calendar.close();
    }
  };
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (sheetOpen() || next === input || (next && calendar.element()?.contains(next))) return;
    if (dirty()) commit();
    calendar.close();
  };

  return (
    <Field
      class={suggestion.field(props.owner.class)}
      label={props.owner.label}
      description={props.owner.description}
      required={props.owner.required}
      disabled={props.owner.disabled}
      meta={meta}
      labelEnd={suggestion.status}
    >
      <div
        class="k2b-date-picker k2b-date-field"
        data-open={calendar.open() ? "true" : undefined}
        data-readonly={props.owner.readOnly ? "true" : undefined}
        onFocusOut={onFocusOut}
      >
        <div ref={shell} class="k2b-input-shell" data-invalid={invalid() ? "true" : undefined} onPointerDown={onPointerDown}>
          <span class="k2b-input-shell__icon k2b-date-field__icon" aria-hidden="true">
            <i class="ti ti-calendar" />
          </span>
          <input
            ref={input}
            {...fieldControlAria(meta, props.owner)}
            id={meta.controlId}
            class="k2b-input"
            type="text"
            inputMode="numeric"
            autocomplete="off"
            spellcheck={false}
            role="combobox"
            aria-haspopup="dialog"
            aria-expanded={calendar.open() || sheetOpen()}
            aria-controls={sheetOpen() ? sheetId : popoverId}
            aria-describedby={suggestion.describe(
              [props.owner["aria-describedby"], props.owner.description ? meta.descriptionId : undefined, statusId]
                .filter(Boolean)
                .join(" "),
            )}
            aria-invalid={invalid() ? "true" : undefined}
            placeholder={suggestion.placeholder() ?? props.owner.placeholder ?? datePattern(locale(), t())}
            value={text()}
            disabled={props.owner.disabled}
            readOnly={props.owner.readOnly}
            onInput={(event) => {
              setText(event.currentTarget.value);
              setDirty(true);
              clearTimeout(announceTimer);
              announceTimer = setTimeout(() => {
                const result = parsed();
                setAnnouncement(result?.kind === "date" ? spokenDateText(result.date, result.note, locale(), t()) : "");
              }, 500);
            }}
            onKeyDown={onKeyDown}
          />
          <Show when={props.owner.clearable && interactive()}>
            <button
              type="button"
              class="k2b-input-shell__clear k2b-input-clear-action k2b-date-field__clear"
              data-hidden={text() ? undefined : "true"}
              aria-label={uiMessages().clearDate}
              onClick={() => {
                pick(null);
                input?.focus();
              }}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </button>
          </Show>
          <Show
            when={!props.owner.readOnly}
            fallback={
              <span class="k2b-date-field__lock" aria-hidden="true">
                <i class="ti ti-lock" />
              </span>
            }
          >
            {/* One tab stop per field: the keyboard opens the calendar with ↓ from the text. */}
            <button
              ref={toggle}
              type="button"
              class="k2b-date-field__toggle"
              tabIndex={-1}
              disabled={props.owner.disabled}
              aria-label={calendar.open() ? t().closeCalendar : t().openCalendar}
              aria-expanded={calendar.open() || sheetOpen()}
              aria-controls={sheetOpen() ? sheetId : popoverId}
              onClick={(event) => {
                // Pointers are handled on pointerdown; this is activation by assistive technology.
                if (event.detail === 0) openCalendar(true);
              }}
            >
              <i class="ti ti-chevron-down" aria-hidden="true" />
            </button>
          </Show>
          <div
            ref={calendar.ref}
            id={popoverId}
            class="k2b-date-popover"
            popover="manual"
            role="dialog"
            aria-label={fieldName(props.owner) ?? uiMessages().datePicker}
            onPointerDown={keepFocus}
            onKeyDown={(event) => {
              if (event.key !== "Escape" && !(event.key === "ArrowUp" && event.altKey)) return;
              event.preventDefault();
              event.stopPropagation();
              calendar.close();
              input?.focus();
            }}
          >
            <Show when={calendar.open()}>
              <div class="k2b-date-popover__body">
                <PresetRail
                  presets={props.owner.presets}
                  onSelect={(value) => {
                    pick(value);
                    caretToEnd(input);
                  }}
                />
                <DatePickerPanel
                  visibleMonth={visibleMonth}
                  setVisibleMonth={setVisibleMonth}
                  selected={draftKey}
                  focusDate={draftKey}
                  onSelect={(key) => {
                    pick(key);
                    caretToEnd(input);
                  }}
                  dateConfig={props.dateConfig()}
                  min={props.owner.min}
                  max={props.owner.max}
                />
              </div>
            </Show>
          </div>
        </div>
        <DateStatusLine
          ref={(element) => {
            statusLine = element;
          }}
          id={statusId}
          tone={status().tone}
          text={status().text}
          announcement={announcement()}
        />
      </div>
    </Field>
  );
}

const datePattern = (locale: string | undefined, t: ReturnType<typeof resolveDateInputMessages>) =>
  dateInputPattern(locale, { day: t.dayLetters, month: t.monthLetters, year: t.yearLetters });

/** "11.11.2026 – 14.11.2026", "11.11. bis 14.11." or "Nov 11 to Nov 14" pasted into either half fills both. */
const splitPastedRange = (text: string): [string, string] | undefined => {
  const parts = text.trim().split(/\s*[–—]\s*|\s+-\s+|\s+(?:bis|to|until)\s+/i);
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : undefined;
};

/** A date-only range as two typed halves in one field; the calendar keeps two clicks and Apply. */
function DateRangeTextField(props: {
  owner: DateRangePickerProps;
  value: () => DateRangeValue;
  dateConfig: () => DateContext;
}): JSX.Element {
  onMount(() => {
    void preloadDatePickerPanel();
  });
  const uiMessages = useUiMessages();
  const meta = createFieldMeta(props.owner.id);
  const locale = () => props.dateConfig().locale;
  const t = createMemo(() => resolveDateInputMessages(locale()));
  const today = () => dateKey(new Date(), props.dateConfig());
  const format = (key: string | null | undefined) => (key ? formatDateInput(key, locale()) : "");
  const limits = () => ({ min: props.owner.min, max: props.owner.max });
  const interactive = () => !props.owner.disabled && !props.owner.readOnly;
  const [startText, setStartText] = createSignal(format(props.value().start));
  const [endText, setEndText] = createSignal(format(props.value().end));
  const [dirty, setDirty] = createSignal(false);
  const [failure, setFailure] = createSignal<string>();
  const [announcement, setAnnouncement] = createSignal("");
  const [visibleMonth, setVisibleMonth] = createSignal(
    parseDateValue(openingDay(props.value().start || props.value().end, limits(), props.dateConfig()), props.dateConfig()),
  );
  // The calendar's own draft: two clicks pick a range, Apply commits it.
  const [picked, setPicked] = createSignal<DateRangeValue>(props.value());
  const [anchor, setAnchor] = createSignal<string | null>(null);
  const [previewDate, setPreviewDate] = createSignal<string | null>(null);
  let shell: HTMLDivElement | undefined;
  let startInput: HTMLInputElement | undefined;
  let endInput: HTMLInputElement | undefined;
  let toggle: HTMLButtonElement | undefined;
  let statusLine: HTMLElement | undefined;
  const [sheetOpen, setSheetOpen] = createSignal(false);
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const wide = () => Boolean(props.owner.datePresets?.length || props.owner.presets?.length);
  const calendar = createCalendarPopover({ anchor: () => shell, below: () => statusLine, wide });
  const popoverId = `${meta.controlId}-calendar`;
  const sheetId = `${meta.controlId}-sheet`;
  // The status line holds the field's message slot, so it carries the `<id>-error` every field family uses.
  const statusId = meta.errorId;
  const name = () => fieldName(props.owner);

  const parse = (value: string): DateInputResult => parseDateInput(value, { today: today(), locale: locale() });
  const halves = createMemo(() => (dirty() ? ([parse(startText()), parse(endText())] as const) : undefined));
  const draft = createMemo((): DateRangeValue => {
    const current = halves();
    if (!current) return props.value();
    const [start, end] = current;
    return { start: start.kind === "date" ? start.date : null, end: end.kind === "date" ? end.date : null };
  });
  const shownRange = createMemo(() => previewRange(picked(), anchor(), previewDate()));

  const fill = (range: DateRangeValue) => {
    setStartText(format(range.start));
    setEndText(format(range.end));
  };
  createEffect(
    on([props.value, locale], () => {
      if (dirty()) return;
      fill(props.value());
      setPicked(props.value());
      setFailure(undefined);
    }),
  );
  createEffect(
    on(draft, (range) => {
      // A day picked in the calendar wrote this text itself; its half-picked range keeps going.
      if (!dirty() || (range.start === picked().start && range.end === picked().end)) return;
      setPicked(range);
      setAnchor(null);
      if (range.start || range.end) setVisibleMonth(parseDateValue(range.start || range.end, props.dateConfig()));
      setFailure(undefined);
    }),
  );
  onCleanup(() => clearTimeout(announceTimer));

  const externalError = () => resolveMaybeAccessor(props.owner.error);
  const invalid = () => Boolean(failure() || externalError());
  const status = createMemo((): { tone: DateStatusTone; text: JSX.Element } => {
    const failed = failure();
    if (failed) return { tone: "error", text: failed };
    const current = halves();
    if (current) {
      const mistake = current.find((half): half is Extract<DateInputResult, { kind: "error" }> => half.kind === "error");
      if (mistake) return { tone: "rest", text: typingStatusText(mistake.error, locale(), t(), today()) };
      const range = draft();
      const limit = [range.start, range.end].map((key) => key && limitErrorText(key, limits(), locale(), t())).find(Boolean);
      if (limit) return { tone: "rest", text: limit };
      const text = rangeStatusText(range, locale(), t());
      return { tone: text ? "draft" : "rest", text: text ? `→ ${text}` : "" };
    }
    const external = externalError();
    if (external) return { tone: "error", text: external };
    return { tone: "rest", text: rangeStatusText(props.value(), locale(), t()) };
  });

  const save = (next: DateRangeValue) => {
    if (next.start !== props.value().start || next.end !== props.value().end) commitFieldValue(props.owner, next);
  };
  const fail = (message: string) => {
    setFailure(message);
    setAnnouncement(message);
  };
  const commitRange = (range: DateRangeValue) => {
    setDirty(false);
    const limit = [range.start, range.end].map((key) => key && limitErrorText(key, limits(), locale(), t())).find(Boolean);
    if (limit) return fail(limit);
    if (range.start && range.end && range.end < range.start) return fail(t().endBeforeStart);
    if (range.start && !range.end) return fail(t().missingEnd);
    if (range.end && !range.start) return fail(t().missingStart);
    if (!range.start && props.owner.required) return fail(t().required);
    setFailure(undefined);
    fill(range);
    setPicked(range);
    save(range);
  };
  const commit = () => {
    const [start, end] = [parse(startText()), parse(endText())];
    const mistake = [start, end].find((half): half is Extract<DateInputResult, { kind: "error" }> => half.kind === "error");
    if (mistake) {
      setDirty(false);
      return fail(errorText(mistake.error, locale(), t(), today()));
    }
    commitRange({ start: start.kind === "date" ? start.date : null, end: end.kind === "date" ? end.date : null });
  };
  const restore = () => {
    fill(props.value());
    setPicked(props.value());
    setAnchor(null);
    setDirty(false);
    setFailure(undefined);
    calendar.close();
  };
  /**
   * A pick in the popover fills the field's text, so the text, the status line and the calendar show the same range.
   * A pick in the phone sheet stays in the sheet until it is saved: the field never shows an unsaved range, also not in
   * the moment between a dismissed sheet and the end of its history step.
   */
  const showPick = (range: DateRangeValue) => {
    if (sheetOpen()) return;
    fill(range);
    setDirty(true);
  };
  /** Calendar clicks fill both halves at once. */
  const pickDay = (key: string) => {
    const next = pickRangeDay(picked(), anchor(), key);
    // One update: the start alone would read as a typed range and reset the anchor of the next click.
    batch(() => {
      setPicked(next.range);
      setAnchor(next.anchor);
      setPreviewDate(null);
      showPick(next.range);
    });
  };
  const apply = (range: DateRangeValue) => {
    commitRange(range);
    calendar.close();
  };
  const canApply = () => Boolean(picked().start) === Boolean(picked().end);

  const rangeCalendar = (onApply: (range: DateRangeValue) => void) => (
    <>
      <div class="k2b-date-popover__body">
        <Show when={props.owner.datePresets?.length} fallback={<PresetRail presets={props.owner.presets} onSelect={onApply} />}>
          <PresetRail
            presets={props.owner.datePresets}
            onSelect={(value) => {
              const next = value ? { start: value, end: value } : { start: null, end: null };
              batch(() => {
                setPicked(next);
                setAnchor(null);
                showPick(next);
              });
              if (value) setVisibleMonth(parseDateValue(value, props.dateConfig()));
            }}
          />
        </Show>
        <DatePickerPanel
          visibleMonth={visibleMonth}
          setVisibleMonth={setVisibleMonth}
          range={shownRange}
          focusDate={() => picked().start}
          onSelect={pickDay}
          onDayPreview={(key) => setPreviewDate(rangeAnchor(picked(), anchor()) ? key : null)}
          dateConfig={props.dateConfig()}
          min={props.owner.min}
          max={props.owner.max}
        />
      </div>
      <div class="k2b-date-actions">
        <Show when={formatDateOnlyRangeDuration(shownRange(), props.dateConfig())}>
          {(duration) => (
            <span class="k2b-date-duration">
              <i class="ti ti-hourglass-low" aria-hidden="true" />
              {duration()}
            </span>
          )}
        </Show>
        <button type="button" class="k2b-date-apply" disabled={!canApply()} onClick={() => onApply(picked())}>
          {uiMessages().apply}
        </button>
      </div>
    </>
  );

  const openSheet = async () => {
    setSheetOpen(true);
    calendar.close();
    // Every opening starts from the text, also after a dismissed sheet left other days picked.
    batch(() => {
      setPicked(draft());
      setAnchor(null);
      setPreviewDate(null);
    });
    // The sheet opens with the context of this tap, not of the moment its code arrives.
    const call = readDialogCall(shell);
    const { openDateSheet } = await import("./date-sheet");
    const range = await openDateSheet<DateRangeValue>(call, {
      title: props.owner.label ?? props.owner["aria-label"],
      subtitle: rangeStatusText(props.value(), locale(), t()) || t().noDate,
      ariaLabel: name(),
      id: sheetId,
      locale: locale() ?? "en",
      content: (close) =>
        rangeCalendar((next) => {
          // Saved at once, as in the single date sheet.
          commitRange(next);
          close(next);
        }),
    });
    setSheetOpen(false);
    // A dismissed sheet saves nothing; its picks never reached the text (see `showPick`).
    if (!range) setAnchor(null);
    toggle?.focus({ preventScroll: true });
  };
  const openCalendar = (focusDay: boolean) => {
    if (!interactive()) return;
    setAnchor(null);
    setPreviewDate(null);
    setPicked(draft());
    if (prefersMenuSheet()) return void openSheet();
    const range = draft();
    setVisibleMonth(parseDateValue(openingDay(range.start || range.end, limits(), props.dateConfig()), props.dateConfig()));
    calendar.show();
    if (focusDay) calendar.focusDay();
  };

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Element;
    if (!interactive() || calendar.element()?.contains(target) || target.closest(".k2b-date-field__clear")) return;
    const onIcon = target.closest(".k2b-date-field__toggle, .k2b-date-field__icon");
    if (prefersMenuSheet()) {
      if (onIcon) {
        event.preventDefault();
        void openSheet();
      }
      return;
    }
    if (onIcon) {
      event.preventDefault();
      if (!shell?.contains(document.activeElement)) startInput?.focus();
      if (calendar.open()) calendar.close();
      else openCalendar(false);
      return;
    }
    if (event.button === 0 && !calendar.open()) setTimeout(() => openCalendar(false));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // A refused text keeps Enter too, so it does not submit the form around it.
    if (event.key === "Enter" && (dirty() || calendar.open() || failure())) {
      event.preventDefault();
      commit();
      calendar.close();
    } else if (event.key === "Escape" && (dirty() || calendar.open() || failure())) {
      event.preventDefault();
      event.stopPropagation();
      restore();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      openCalendar(true);
    } else if (event.key === "ArrowUp" && event.altKey) {
      event.preventDefault();
      calendar.close();
    }
  };
  const onInput = (setter: (value: string) => void) => (event: InputEvent & { currentTarget: HTMLInputElement }) => {
    setter(event.currentTarget.value);
    setDirty(true);
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const range = draft();
      setAnnouncement(range.start || range.end ? rangeStatusText(range, locale(), t()) : "");
    }, 500);
  };
  const onPaste = (event: ClipboardEvent) => {
    const parts = splitPastedRange(event.clipboardData?.getData("text") ?? "");
    if (!parts) return;
    event.preventDefault();
    setStartText(parts[0]);
    setEndText(parts[1]);
    setDirty(true);
  };
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (sheetOpen() || (next && shell?.contains(next))) return;
    if (dirty()) commit();
    calendar.close();
  };
  const inputProps = {
    class: "k2b-input",
    type: "text",
    inputMode: "numeric",
    autocomplete: "off",
    spellcheck: false,
    "aria-haspopup": "dialog",
    onKeyDown,
    onPaste,
  } as const;
  const describedBy = () =>
    [props.owner["aria-describedby"], props.owner.description ? meta.descriptionId : undefined, statusId].filter(Boolean).join(" ");

  return (
    <Field
      class={props.owner.class}
      label={props.owner.label}
      description={props.owner.description}
      required={props.owner.required}
      disabled={props.owner.disabled}
      meta={meta}
    >
      <div
        class="k2b-date-picker k2b-date-field"
        data-range="true"
        data-open={calendar.open() ? "true" : undefined}
        data-readonly={props.owner.readOnly ? "true" : undefined}
        onFocusOut={onFocusOut}
      >
        <div
          ref={shell}
          class="k2b-input-shell"
          role="group"
          aria-labelledby={props.owner.label ? meta.labelId : undefined}
          aria-label={props.owner.label ? undefined : props.owner["aria-label"]}
          data-invalid={invalid() ? "true" : undefined}
          onPointerDown={onPointerDown}
        >
          <span class="k2b-input-shell__icon k2b-date-field__icon" aria-hidden="true">
            <i class="ti ti-calendar-stats" />
          </span>
          <input
            ref={startInput}
            {...inputProps}
            role="combobox"
            aria-controls={sheetOpen() ? sheetId : popoverId}
            id={meta.controlId}
            aria-label={name() ? t().startOf({ label: name()! }) : t().start}
            aria-expanded={calendar.open() || sheetOpen()}
            aria-describedby={describedBy()}
            aria-invalid={invalid() ? "true" : undefined}
            aria-required={props.owner.required || undefined}
            placeholder={t().start}
            value={startText()}
            disabled={props.owner.disabled}
            readOnly={props.owner.readOnly}
            onInput={onInput(setStartText)}
          />
          <i class="ti ti-arrow-narrow-right k2b-date-field__arrow" aria-hidden="true" />
          <input
            ref={endInput}
            {...inputProps}
            role="combobox"
            aria-controls={sheetOpen() ? sheetId : popoverId}
            aria-label={name() ? t().endOf({ label: name()! }) : t().end}
            aria-expanded={calendar.open() || sheetOpen()}
            aria-describedby={describedBy()}
            aria-invalid={invalid() ? "true" : undefined}
            aria-required={props.owner.required || undefined}
            placeholder={t().end}
            value={endText()}
            disabled={props.owner.disabled}
            readOnly={props.owner.readOnly}
            onInput={onInput(setEndText)}
          />
          <span class="k2b-date-field__spacer" />
          <Show when={props.owner.clearable && interactive()}>
            <button
              type="button"
              class="k2b-input-shell__clear k2b-input-clear-action k2b-date-field__clear"
              data-hidden={startText() || endText() ? undefined : "true"}
              aria-label={uiMessages().clearDate}
              onClick={() => {
                commitRange({ start: null, end: null });
                startInput?.focus();
              }}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </button>
          </Show>
          <Show
            when={!props.owner.readOnly}
            fallback={
              <span class="k2b-date-field__lock" aria-hidden="true">
                <i class="ti ti-lock" />
              </span>
            }
          >
            <button
              ref={toggle}
              type="button"
              class="k2b-date-field__toggle"
              tabIndex={-1}
              disabled={props.owner.disabled}
              aria-label={calendar.open() ? t().closeCalendar : t().openCalendar}
              aria-expanded={calendar.open() || sheetOpen()}
              aria-controls={sheetOpen() ? sheetId : popoverId}
              onClick={(event) => {
                if (event.detail === 0) openCalendar(true);
              }}
            >
              <i class="ti ti-chevron-down" aria-hidden="true" />
            </button>
          </Show>
          <div
            ref={calendar.ref}
            id={popoverId}
            class="k2b-date-popover"
            popover="manual"
            role="dialog"
            aria-label={name() ?? uiMessages().datePicker}
            onPointerDown={keepFocus}
            onKeyDown={(event) => {
              if (event.key !== "Escape" && !(event.key === "ArrowUp" && event.altKey)) return;
              event.preventDefault();
              event.stopPropagation();
              calendar.close();
              startInput?.focus();
            }}
          >
            <Show when={calendar.open()}>
              {rangeCalendar((range) => {
                apply(range);
                caretToEnd(endInput);
              })}
            </Show>
          </div>
        </div>
        <DateStatusLine
          ref={(element) => {
            statusLine = element;
          }}
          id={statusId}
          tone={status().tone}
          text={status().text}
          announcement={announcement()}
        />
      </div>
    </Field>
  );
}

export function DatePicker(props: DatePickerProps): JSX.Element {
  const value = () => resolveMaybeAccessor(props.value);
  const dateConfig = useDateConfigLocale(() => props.dateConfig);
  const [visibleMonth, setVisibleMonth] = createSignal(parseDateValue(value(), dateConfig()));
  const valueLabel = () => displayDate(value(), dateConfig());

  return (
    <Show when={props.appearance === "plain"} fallback={<DateTextField owner={props} value={value} dateConfig={dateConfig} />}>
      <PickerShell
        owner={props}
        icon="ti ti-calendar"
        valueLabel={valueLabel}
        valueContent={props.renderValue ? () => props.renderValue!(value()!) : undefined}
        clearValue={null}
        onOpen={() => setVisibleMonth(parseDateValue(openingDay(value(), { min: props.min, max: props.max }, dateConfig()), dateConfig()))}
        wide={Boolean(props.presets?.length)}
      >
        {(close) => (
          <div class="k2b-date-popover__body">
            <PresetRail
              presets={props.presets}
              onSelect={(value) => {
                close();
                commitFieldValue(props, value);
              }}
            />
            <DatePickerPanel
              visibleMonth={visibleMonth}
              setVisibleMonth={setVisibleMonth}
              selected={value}
              focusDate={value}
              onSelect={(value) => {
                close();
                commitFieldValue(props, value);
              }}
              dateConfig={dateConfig()}
              min={props.min}
              max={props.max}
            />
          </div>
        )}
      </PickerShell>
    </Show>
  );
}

export function DateTimePicker(props: DateTimePickerProps): JSX.Element {
  const messages = useUiMessages();
  const value = () => resolveMaybeAccessor(props.value);
  const dateConfig = useDateConfigLocale(() => props.dateConfig);
  const parts = () => splitDateTime(value(), dateConfig());
  const defaultTime = () => props.defaultTime ?? "09:00";
  // Without `optionalTime` every value has a time; with it a date key has none.
  const valueHasTime = () => !props.optionalTime || (Boolean(value()) && !isDateKey(value()!));
  const [visibleMonth, setVisibleMonth] = createSignal(parseDateValue(parts().date, dateConfig()));
  const [draftDate, setDraftDate] = createSignal(parts().date);
  const [draftTime, setDraftTime] = createSignal(parts().time || defaultTime());
  const [withTime, setWithTime] = createSignal(valueHasTime());
  const valueLabel = () => (valueHasTime() ? formatDateTimeValue(value(), dateConfig()) : displayDate(value(), dateConfig()));
  let addTimeButton: HTMLButtonElement | undefined;
  let timeField: HTMLDivElement | undefined;

  const syncDraft = () => {
    const next = parts();
    setDraftDate(next.date);
    setDraftTime(next.time || defaultTime());
    setWithTime(valueHasTime());
    setVisibleMonth(parseDateValue(openingDay(next.date, { min: props.min, max: props.max }, dateConfig()), dateConfig()));
  };
  const canApply = () => Boolean(draftDate()) && (!withTime() || isCompleteTime(draftTime()));
  const draftValue = () =>
    withTime() ? draftDateTimeValue(valueHasTime() ? value() : null, draftDate(), draftTime(), dateConfig()) : draftDate() || null;
  const addTime = () => {
    setWithTime(true);
    queueMicrotask(() => timeField?.querySelector("input")?.focus());
  };
  const removeTime = () => {
    setWithTime(false);
    queueMicrotask(() => addTimeButton?.focus());
  };

  return (
    <PickerShell
      owner={props}
      icon={props.optionalTime && !valueHasTime() ? "ti ti-calendar" : "ti ti-calendar-time"}
      valueLabel={valueLabel}
      valueContent={props.renderValue ? () => props.renderValue!(value()!) : undefined}
      clearValue={null}
      timezone={dateConfig().timeZone}
      onOpen={syncDraft}
      wide={Boolean(props.presets?.length)}
    >
      {(close) => {
        const apply = () => {
          if (!canApply()) return;
          const next = draftValue();
          close();
          commitFieldValue(props, next);
        };
        return (
          <>
            <div class="k2b-date-popover__body">
              <PresetRail
                presets={props.presets}
                onSelect={(value) => {
                  close();
                  commitFieldValue(props, value);
                }}
              />
              <DatePickerPanel
                visibleMonth={visibleMonth}
                setVisibleMonth={setVisibleMonth}
                selected={draftDate}
                focusDate={draftDate}
                onSelect={(value) => {
                  setDraftDate(value);
                  setVisibleMonth(parseDateValue(value, dateConfig()));
                  // A date without a time is complete with the day, as in the date picker.
                  if (props.optionalTime && !withTime()) apply();
                }}
                dateConfig={dateConfig()}
                min={props.min}
                max={props.max}
              />
            </div>
            <div class="k2b-date-actions">
              <Show when={props.optionalTime} fallback={<TimeInput time={draftTime()} onChange={setDraftTime} />}>
                {/* Adding and removing the time swap controls of one height in one place, so the panel never moves. */}
                <div ref={timeField} class="k2b-date-optional-time" data-with-time={withTime() ? "true" : undefined}>
                  <Show
                    when={withTime()}
                    fallback={
                      <button ref={addTimeButton} type="button" class="k2b-date-optional-time__add" onClick={addTime}>
                        <i class="ti ti-clock-plus" aria-hidden="true" />
                        {messages().addTime}
                      </button>
                    }
                  >
                    <TimeInput time={draftTime()} onChange={setDraftTime} />
                    <button
                      type="button"
                      class="k2b-date-optional-time__remove"
                      aria-label={messages().removeTime}
                      title={messages().removeTime}
                      onClick={removeTime}
                    >
                      <i class="ti ti-x" aria-hidden="true" />
                    </button>
                  </Show>
                </div>
              </Show>
              <button type="button" class="k2b-date-apply" disabled={!canApply()} onClick={apply}>
                {messages().apply}
              </button>
            </div>
          </>
        );
      }}
    </PickerShell>
  );
}

export function DateRangePicker(props: DateRangePickerProps): JSX.Element {
  const messages = useUiMessages();
  const withTime = () => props.withTime ?? false;
  const value = () => resolveMaybeAccessor(props.value);
  const dateConfig = useDateConfigLocale(() => props.dateConfig);
  const parts = () => ({
    start: withTime() ? splitDateTime(value().start, dateConfig()) : { date: value().start ?? "", time: "09:00" },
    end: withTime() ? splitDateTime(value().end, dateConfig()) : { date: value().end ?? "", time: "10:00" },
  });
  const [visibleMonth, setVisibleMonth] = createSignal(parseDateValue(parts().start.date || parts().end.date, dateConfig()));
  const [draftRange, setDraftRange] = createSignal<DateRangeValue>({
    start: parts().start.date || null,
    end: parts().end.date || null,
  });
  // The day of the last click that started a one-day range; the next click on another day extends from it.
  const [anchor, setAnchor] = createSignal<string | null>(null);
  const [previewDate, setPreviewDate] = createSignal<string | null>(null);
  const [startTime, setStartTime] = createSignal(parts().start.time || "09:00");
  const [endTime, setEndTime] = createSignal(parts().end.time || "10:00");
  const displayRange = createMemo(() => previewRange(draftRange(), anchor(), previewDate()));

  const syncDraft = () => {
    const next = parts();
    setDraftRange({ start: next.start.date || null, end: next.end.date || null });
    setAnchor(null);
    setPreviewDate(null);
    setStartTime(next.start.time || "09:00");
    setEndTime(next.end.time || "10:00");
    setVisibleMonth(
      parseDateValue(openingDay(next.start.date || next.end.date, { min: props.min, max: props.max }, dateConfig()), dateConfig()),
    );
  };

  const valueLabel = () => {
    if (!value().start && !value().end) return "";
    const format = withTime() ? formatDateTimeValue : displayDate;
    return `${value().start ? format(value().start, dateConfig()) : "Start"} to ${value().end ? format(value().end, dateConfig()) : "End"}`;
  };

  const valueContent = () => {
    const format = withTime() ? formatDateTimeValue : displayDate;
    return (
      <span class="k2b-date-range-value">
        <span>{value().start ? format(value().start, dateConfig()) : messages().start}</span>
        <i class="ti ti-arrow-narrow-right" aria-hidden="true" />
        <span>{value().end ? format(value().end, dateConfig()) : "End"}</span>
      </span>
    );
  };

  const selectDate = (value: string) => {
    const next = pickRangeDay(draftRange(), anchor(), value);
    setDraftRange(next.range);
    setAnchor(next.anchor);
    setPreviewDate(null);
  };

  const applyDuration = (minutes: number) => {
    const current = draftRange();
    if (!current.start || !isCompleteTime(startTime())) return;
    const start = toDateTimeValue(current.start, startTime(), dateConfig());
    if (!start) return;
    const end = new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
    const next = splitDateTime(end, dateConfig());
    setDraftRange({ start: current.start, end: next.date || current.end || current.start });
    setEndTime(next.time || endTime());
  };

  const durationMinutes = createMemo(() => {
    const current = displayRange();
    if (!current.start || !current.end || !isCompleteTime(startTime()) || !isCompleteTime(endTime())) return null;
    const start = toDateTimeValue(current.start, startTime(), dateConfig());
    const end = toDateTimeValue(current.end, endTime(), dateConfig());
    if (!start || !end) return null;
    return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000);
  });

  const durationLabel = () => {
    const current = displayRange();
    if (!current.start || !current.end) return "";
    if (!withTime()) return formatDateOnlyRangeDuration(current, dateConfig());
    if (!isCompleteTime(startTime()) || !isCompleteTime(endTime())) return "";
    const start = toDateTimeValue(current.start, startTime(), dateConfig());
    const end = toDateTimeValue(current.end, endTime(), dateConfig());
    return start && end ? dates.formatDuration(start, end, dateConfig()) : "";
  };

  const commit = (close: () => void) => {
    const current = draftRange();
    if (!withTime()) {
      close();
      commitFieldValue(props, current);
      return;
    }
    if ((current.start || current.end) && (!isCompleteTime(startTime()) || !isCompleteTime(endTime()))) return;
    const committed = resolveMaybeAccessor(props.value);
    const value = {
      start: current.start ? draftDateTimeValue(committed.start, current.start, startTime(), dateConfig()) : null,
      end: current.end ? draftDateTimeValue(committed.end, current.end, endTime(), dateConfig()) : null,
    };
    close();
    commitFieldValue(props, value);
  };

  return (
    <Show
      when={props.appearance === "plain" || withTime()}
      fallback={<DateRangeTextField owner={props} value={value} dateConfig={dateConfig} />}
    >
      <PickerShell
        owner={props}
        icon="ti ti-calendar-stats"
        valueLabel={valueLabel}
        valueContent={valueContent}
        clearValue={{ start: null, end: null }}
        timezone={withTime() ? dateConfig().timeZone : undefined}
        footerMeta={() => (
          <Show when={durationLabel()}>
            <span class="k2b-date-duration">
              <i class="ti ti-hourglass-low" aria-hidden="true" />
              {durationLabel()}
            </span>
          </Show>
        )}
        onOpen={syncDraft}
        wide={Boolean(props.datePresets?.length || props.presets?.length)}
      >
        {(close) => (
          <>
            <div class="k2b-date-popover__body">
              <Show
                when={props.datePresets?.length}
                fallback={
                  <PresetRail
                    presets={props.presets}
                    onSelect={(value) => {
                      close();
                      commitFieldValue(props, value);
                    }}
                  />
                }
              >
                <PresetRail
                  presets={props.datePresets}
                  onSelect={(value) => {
                    setDraftRange(value ? { start: value, end: value } : { start: null, end: null });
                    if (value) setVisibleMonth(parseDateValue(value, dateConfig()));
                  }}
                />
              </Show>
              <DatePickerPanel
                visibleMonth={visibleMonth}
                setVisibleMonth={setVisibleMonth}
                range={displayRange}
                focusDate={() => draftRange().start}
                onSelect={selectDate}
                onDayPreview={(value) => setPreviewDate(rangeAnchor(draftRange(), anchor()) ? value : null)}
                dateConfig={dateConfig()}
                min={props.min}
                max={props.max}
              />
            </div>

            <Show when={withTime()}>
              <div class="k2b-date-range-times">
                <TimeInput label={messages().start} time={startTime()} onChange={setStartTime} />
                <TimeInput label={messages().end} time={endTime()} onChange={setEndTime} />
              </div>
            </Show>

            <div class="k2b-date-actions">
              <Show when={withTime() && props.durationPresets?.length}>
                <div class="k2b-date-durations" role="group" aria-label={messages().durationPresets}>
                  <For each={props.durationPresets}>
                    {(preset) => (
                      <button
                        type="button"
                        aria-pressed={durationMinutes() === preset.minutes}
                        onClick={() => applyDuration(preset.minutes)}
                      >
                        {preset.label}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              {/* Only a half-picked range is uncommittable; an empty draft must stay
                applicable so a "clear" date preset can be committed. */}
              <button
                type="button"
                class="k2b-date-apply"
                disabled={
                  Boolean(draftRange().start) !== Boolean(draftRange().end) ||
                  Boolean(
                    withTime() && draftRange().start && draftRange().end && (!isCompleteTime(startTime()) || !isCompleteTime(endTime())),
                  )
                }
                onClick={() => commit(close)}
              >
                {messages().apply}
              </button>
            </div>
          </>
        )}
      </PickerShell>
    </Show>
  );
}
