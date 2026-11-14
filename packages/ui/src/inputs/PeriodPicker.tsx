import { dates } from "@k2b/stdlib";
import { batch, createComputed, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import { prefersMenuSheet } from "../actions/phone-sheet";
import { createFieldMeta, Field, fieldDescribedBy } from "../internal/field";
import { returnFocus, ringOnReturn } from "../internal/focus-return";
import { useDateConfigLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { DatePickerPanel } from "./DatePicker";
import { dateInputPattern, formatDateInput, parseDateInput } from "./date-input";
import { resolveDateInputMessages } from "./date-input-messages";
import { errorText } from "./date-input-status";
import { type DateRangeValue, parseDateValue, pickRangeDay, previewRange, rangeAnchor } from "./date-picker";
import type { DateContext, MaybeAccessor, ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import {
  formatPeriodDays,
  formatPeriodRange,
  type PeriodPreset,
  type PeriodRange,
  type PeriodValue,
  periodContext,
  periodDayCount,
  widePeriodRangeSample,
} from "./period";
import { builtInPresetLabel, type PeriodPickerMessages, usePeriodPickerMessages } from "./period-picker-messages";

export type PeriodPickerProps = Omit<ValueFieldProps<PeriodValue | null>, "value"> & {
  /** A preset key or two explicit days; `null` or an unknown preset key shows the placeholder. */
  value: MaybeAccessor<PeriodValue | null>;
  /** The presets in list order, for example `periodPresets.thisMonth` or an app's own `{ key, label, resolve }`. */
  presets: readonly PeriodPreset[];
  /** Offers "Custom range" with a calendar in the same popover. On by default. */
  custom?: boolean;
  /** Time zone, week start and locale. Presets resolve "today" in `timeZone`; pass the zone the data uses. */
  dateConfig?: DateContext;
  /** The instant "today" is read from. Pass the server's instant so the first render and the browser agree. */
  now?: Date;
  /** Shows that a change is saving: the trigger keeps its size, cannot be opened, and shows a spinner. */
  loading?: boolean;
};

type PeriodText = { label: string; detail: string };
type View = "list" | "custom";

/** Two months side by side need room for the list and both calendars. */
const TWO_MONTHS_QUERY = "(min-width: 56rem)";

const presetLabel = (preset: PeriodPreset, t: PeriodPickerMessages): string =>
  preset.label ?? builtInPresetLabel(t, preset.key) ?? preset.key;

/** Places the popover under (or over) the trigger; it grows toward the side with room, right-aligned near the right edge. */
const placePeriodPopover = (trigger: HTMLElement, popover: HTMLElement): void => {
  const margin = 8;
  const gap = 4;
  const rect = trigger.getBoundingClientRect();
  const box = popover.getBoundingClientRect();
  const width = Math.min(box.width, window.innerWidth - margin * 2);
  const fromLeft = rect.left;
  const fromRight = rect.right - width;
  const left = fromLeft + width <= window.innerWidth - margin ? fromLeft : Math.max(margin, fromRight);
  const roomBelow = window.innerHeight - rect.bottom - gap - margin;
  const roomAbove = rect.top - gap - margin;
  const above = box.height > roomBelow && roomAbove > roomBelow;
  const top = above ? Math.max(margin, rect.top - box.height - gap) : Math.min(rect.bottom + gap, window.innerHeight - box.height - margin);
  popover.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - width - margin))}px`;
  popover.style.top = `${Math.max(margin, top)}px`;
};

const popoverIsOpen = (popover: HTMLElement | undefined): boolean => {
  try {
    return Boolean(popover?.matches(":popover-open"));
  } catch {
    return false;
  }
};

/**
 * PeriodPicker — one control for the period an evaluation or dashboard shows: presets such as "This month" plus a
 * custom range, edited in the same popover (a bottom sheet on phones). The trigger shows the preset with its days or
 * the custom days with their count, and keeps the width of its longest text so nothing beside it moves.
 */
export function PeriodPicker(props: PeriodPickerProps): JSX.Element {
  const t = usePeriodPickerMessages();
  const meta = createFieldMeta(props.id);
  const dateConfig = useDateConfigLocale(() => props.dateConfig);
  const locale = () => dateConfig().locale ?? "en";
  const value = () => resolveMaybeAccessor(props.value);
  const custom = () => props.custom ?? true;
  const disabled = createMemo(() => Boolean(props.disabled || props.loading));
  // Read again on every opening, so a picker left open past midnight shows the new day's presets next time.
  const [clockTick, setClockTick] = createSignal(0);
  const context = createMemo(() => {
    clockTick();
    return periodContext({
      now: props.now,
      timeZone: dateConfig().timeZone,
      weekStartsOn: dateConfig().weekStartsOn ?? dateConfig().firstDayOfWeek,
    });
  });
  const since = (date: string) => t().since({ date });
  const presetText = (preset: PeriodPreset): PeriodText => ({
    label: presetLabel(preset, t()),
    detail: formatPeriodDays(preset.resolve(context()), context().today, locale(), since),
  });
  const rangeText = (range: { start: string; end: string }): PeriodText => ({
    label: formatPeriodRange(range, locale()),
    detail: t().days({ count: periodDayCount(range) }),
  });
  const selectedPreset = () => {
    const current = value();
    return current && "preset" in current ? props.presets.find((preset) => preset.key === current.preset) : undefined;
  };
  const current = createMemo((): PeriodText | undefined => {
    const selected = value();
    if (!selected) return undefined;
    if ("preset" in selected) {
      const preset = selectedPreset();
      return preset ? presetText(preset) : undefined;
    }
    return rangeText(selected);
  });
  const joined = (text: PeriodText) => (text.detail ? `${text.label} · ${text.detail}` : text.label);
  // Every text the trigger can show shares one grid cell, so it keeps the widest one's width.
  const widths = createMemo(() => [
    ...props.presets.map((preset) => joined(presetText(preset))),
    ...(custom() ? [joined(rangeText(widePeriodRangeSample(context().today)))] : []),
    t().choosePeriod,
  ]);

  const [open, setOpen] = createSignal(false);
  const [view, setView] = createSignal<View>("list");
  const [sheetOpen, setSheetOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  let openedByKeyboard = false;
  const popoverId = `${meta.controlId}-period`;
  const sheetId = `${meta.controlId}-sheet`;
  const valueId = `${meta.controlId}-value`;

  // A trigger disabled while a change saves would drop keyboard focus on the page; it comes back once enabled.
  let refocus = false;
  createComputed(
    on(
      disabled,
      (isDisabled) => {
        if (isDisabled) refocus = trigger !== undefined && document.activeElement === trigger;
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      disabled,
      (isDisabled) => {
        if (isDisabled || !refocus) return;
        refocus = false;
        const active = document.activeElement;
        if (trigger?.isConnected && (active === null || active === document.body)) trigger.focus();
      },
      { defer: true },
    ),
  );

  const place = () => {
    if (trigger && popover && open()) placePeriodPopover(trigger, popover);
  };
  createEffect(() => {
    if (!open()) return;
    view();
    queueMicrotask(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    onCleanup(() => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    });
  });

  const close = () => {
    // Before hiding, so the popover does not return focus on its own.
    if (popover?.contains(document.activeElement)) returnFocus(trigger, openedByKeyboard);
    if (popoverIsOpen(popover)) popover?.hidePopover();
    setOpen(false);
  };
  onCleanup(() => {
    if (popoverIsOpen(popover)) popover?.hidePopover();
  });

  const pick = (next: PeriodValue) => {
    close();
    if (sheetOpen()) return;
    commitFieldValue(props, next);
  };

  const initialView = (): View => {
    const selected = value();
    return custom() && selected && !("preset" in selected) ? "custom" : "list";
  };

  const openSheet = async () => {
    setSheetOpen(true);
    const { openDateSheet } = await import("./date-sheet");
    const result = await openDateSheet<PeriodValue>({
      title: typeof props.label === "string" ? props.label : (props["aria-label"] ?? t().period),
      subtitle: current() ? joined(current()!) : t().choosePeriod,
      ariaLabel: typeof props.label === "string" ? props.label : (props["aria-label"] ?? t().period),
      id: sheetId,
      locale: locale(),
      content: (closeSheet) => (
        <PeriodPanel
          sheet
          presets={props.presets}
          custom={custom()}
          value={value}
          initialView={initialView()}
          context={context}
          dateConfig={dateConfig}
          presetText={presetText}
          rangeText={rangeText}
          label={props["aria-label"] ?? t().period}
          onPick={closeSheet}
        />
      ),
    });
    setSheetOpen(false);
    if (result) commitFieldValue(props, result);
    trigger?.focus({ preventScroll: true });
  };

  const show = () => {
    if (disabled() || !popover) return;
    setClockTick((tick) => tick + 1);
    openedByKeyboard = ringOnReturn(trigger);
    if (prefersMenuSheet()) return void openSheet();
    setView(initialView());
    popover.showPopover();
    setOpen(true);
    queueMicrotask(() => {
      place();
      popover?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus();
    });
  };

  const name = () =>
    props.label ? undefined : `${props["aria-label"] ?? t().period}: ${current() ? joined(current()!) : t().choosePeriod}`;

  return (
    <Field
      class={`k2b-period-picker ${props.class ?? ""}`}
      label={props.label}
      description={props.description}
      error={props.error}
      meta={meta}
      required={props.required}
      disabled={disabled()}
    >
      <button
        ref={trigger}
        id={meta.controlId}
        type="button"
        class="k2b-period-picker__trigger"
        aria-haspopup="dialog"
        aria-expanded={open() || sheetOpen()}
        aria-controls={sheetOpen() ? sheetId : popoverId}
        aria-label={name()}
        aria-labelledby={props.label ? `${meta.labelId} ${valueId}` : undefined}
        aria-describedby={fieldDescribedBy(meta, props)}
        aria-invalid={resolveMaybeAccessor(props.error) ? "true" : undefined}
        aria-busy={props.loading ? "true" : undefined}
        disabled={disabled()}
        onClick={() => (open() ? close() : show())}
        onKeyDown={(event) => {
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open()) {
            event.preventDefault();
            show();
          }
        }}
      >
        <i class="ti ti-calendar" aria-hidden="true" />
        <span class="k2b-period-picker__value" data-placeholder={current() ? undefined : "true"}>
          <span id={valueId}>
            <Show when={current()} fallback={t().choosePeriod}>
              {(text) => (
                <>
                  {text().label}
                  <Show when={text().detail}>
                    <span class="k2b-period-picker__detail"> · {text().detail}</span>
                  </Show>
                </>
              )}
            </Show>
          </span>
          <For each={widths()}>{(text) => <span aria-hidden="true">{text}</span>}</For>
        </span>
        {/* Both glyphs are one icon wide, so a saving picker keeps its size. */}
        <i class={props.loading ? "ti ti-loader-2 k2b-spin" : "ti ti-chevron-down"} aria-hidden="true" />
      </button>
      <div
        ref={(element) => {
          popover = element;
          // Light dismiss (a click outside) hides it without us; keep the state in step.
          element.addEventListener("toggle", () => {
            if (!popoverIsOpen(element)) setOpen(false);
          });
        }}
        id={popoverId}
        class="k2b-period-picker__popover"
        popover="auto"
        role="dialog"
        aria-label={props["aria-label"] ?? (typeof props.label === "string" ? props.label : t().period)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      >
        <Show when={open()}>
          <PeriodPanel
            presets={props.presets}
            custom={custom()}
            value={value}
            initialView={view()}
            onViewChange={setView}
            context={context}
            dateConfig={dateConfig}
            presetText={presetText}
            rangeText={rangeText}
            label={props["aria-label"] ?? t().period}
            onPick={pick}
          />
        </Show>
      </div>
    </Field>
  );
}

function PeriodPanel(props: {
  presets: readonly PeriodPreset[];
  custom: boolean;
  value: () => PeriodValue | null;
  initialView: View;
  onViewChange?: (view: View) => void;
  context: () => { today: string; weekStartsOn: 0 | 1 };
  dateConfig: () => DateContext;
  presetText: (preset: PeriodPreset) => PeriodText;
  rangeText: (range: { start: string; end: string }) => PeriodText;
  label: string;
  sheet?: boolean;
  onPick: (value: PeriodValue) => void;
}): JSX.Element {
  const t = usePeriodPickerMessages();
  const [view, setViewSignal] = createSignal<View>(props.initialView);
  const setView = (next: View) => {
    setViewSignal(next);
    props.onViewChange?.(next);
  };
  const selected = () => props.value();
  const explicit = () => {
    const current = selected();
    return current && !("preset" in current) ? current : undefined;
  };
  const isSelected = (preset: PeriodPreset) => {
    const current = selected();
    return Boolean(current && "preset" in current && current.preset === preset.key);
  };
  const optionCount = () => props.presets.length + (props.custom ? 1 : 0);
  const initialActive = () => {
    const index = props.presets.findIndex(isSelected);
    if (index >= 0) return index;
    return explicit() && props.custom ? props.presets.length : 0;
  };
  const [active, setActive] = createSignal(initialActive());
  let list: HTMLDivElement | undefined;
  const focusOption = (index: number) => {
    setActive(index);
    queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-option-index="${index}"]`)?.focus());
  };
  const onListKeyDown = (event: KeyboardEvent) => {
    const count = optionCount();
    const moves: Partial<Record<string, number>> = {
      ArrowDown: (active() + 1) % count,
      ArrowUp: (active() - 1 + count) % count,
      Home: 0,
      End: count - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    focusOption(next);
  };
  let panel: HTMLDivElement | undefined;
  const openCustom = () => {
    setActive(props.presets.length);
    setView("custom");
    // In the sheet the list goes away with the focused option; focus continues on the calendar's day.
    if (props.sheet) queueMicrotask(() => panel?.querySelector<HTMLElement>('[data-date-focus="true"]')?.focus());
  };

  return (
    <div ref={panel} class="k2b-period-picker__panel" data-view={view()} data-sheet={props.sheet ? "true" : undefined}>
      <Show when={!props.sheet || view() === "list"}>
        <div ref={list} class="k2b-period-picker__list" role="listbox" aria-label={props.label} onKeyDown={onListKeyDown}>
          <For each={props.presets}>
            {(preset, index) => {
              const text = () => props.presetText(preset);
              return (
                <button
                  type="button"
                  role="option"
                  class="k2b-dropdown__item k2b-period-picker__option"
                  data-option-index={index()}
                  aria-selected={isSelected(preset) && view() === "list"}
                  tabIndex={active() === index() ? 0 : -1}
                  onFocus={() => setActive(index())}
                  onClick={() => props.onPick({ preset: preset.key })}
                >
                  <span class="k2b-dropdown__copy">
                    <span>{text().label}</span>
                  </span>
                  <span class="k2b-period-picker__hint">{text().detail}</span>
                  <i
                    class="ti ti-check k2b-dropdown__check"
                    aria-hidden="true"
                    data-hidden={isSelected(preset) && view() === "list" ? undefined : "true"}
                  />
                </button>
              );
            }}
          </For>
          <Show when={props.custom}>
            <button
              type="button"
              role="option"
              class="k2b-dropdown__item k2b-period-picker__option k2b-period-picker__custom"
              data-option-index={props.presets.length}
              aria-selected={view() === "custom" || Boolean(explicit())}
              tabIndex={active() === props.presets.length ? 0 : -1}
              onFocus={() => setActive(props.presets.length)}
              onClick={openCustom}
            >
              <span class="k2b-dropdown__copy">
                <span>{t().custom}</span>
              </span>
              <span class="k2b-period-picker__hint">{explicit() ? props.rangeText(explicit()!).label : ""}</span>
              <i class="ti ti-chevron-right k2b-dropdown__check" aria-hidden="true" />
            </button>
          </Show>
        </div>
      </Show>
      <Show when={view() === "custom"}>
        <RangeEditor
          initial={(() => {
            const current = explicit();
            if (current) return current;
            const preset = props.presets.find(isSelected);
            const range: PeriodRange | undefined = preset?.resolve(props.context());
            return range?.start && range.end ? { start: range.start, end: range.end } : null;
          })()}
          today={props.context().today}
          dateConfig={props.dateConfig}
          rangeText={props.rangeText}
          sheet={props.sheet}
          onBack={() => {
            setView("list");
            focusOption(props.presets.length);
          }}
          onApply={(range) => props.onPick(range)}
        />
      </Show>
    </div>
  );
}

function RangeEditor(props: {
  initial: { start: string; end: string } | null;
  today: string;
  dateConfig: () => DateContext;
  rangeText: (range: { start: string; end: string }) => PeriodText;
  sheet?: boolean;
  onBack: () => void;
  onApply: (range: { start: string; end: string }) => void;
}): JSX.Element {
  const t = usePeriodPickerMessages();
  const ui = useUiMessages();
  const locale = () => props.dateConfig().locale ?? "en";
  const inputT = () => resolveDateInputMessages(locale());
  const config = () => ({ ...props.dateConfig(), weekStartsOn: props.dateConfig().weekStartsOn ?? props.dateConfig().firstDayOfWeek ?? 1 });
  const [draft, setDraft] = createSignal<DateRangeValue>({ start: props.initial?.start ?? null, end: props.initial?.end ?? null });
  const [anchor, setAnchor] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<string | null>(null);
  const [startText, setStartText] = createSignal(props.initial ? formatDateInput(props.initial.start, locale()) : "");
  const [endText, setEndText] = createSignal(props.initial ? formatDateInput(props.initial.end, locale()) : "");
  const [startError, setStartError] = createSignal("");
  const [endError, setEndError] = createSignal("");
  // Follows the window: narrowing it below two months' room drops the second month, widening adds it.
  const query = !props.sheet && typeof matchMedia === "function" ? matchMedia(TWO_MONTHS_QUERY) : undefined;
  const [wide, setWide] = createSignal(Boolean(query?.matches));
  if (query) {
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  }
  const twoMonths = () => !props.sheet && wide();
  // Months are anchored on their 1st: stepping from 31 March or 30 November never skips a month.
  const monthOf = (key: string, offset = 0) => {
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7)) - 1 + offset;
    return parseDateValue(`${year + Math.floor(month / 12)}-${String((((month % 12) + 12) % 12) + 1).padStart(2, "0")}-01`, config());
  };
  const keyOf = (date: Date) => dates.formatDateKey(date, config());
  // The first visible month: the end's month, and the one before it when two months show.
  const [first, setFirstMonth] = createSignal(monthOf(props.initial?.end ?? props.today, twoMonths() ? -1 : 0));
  const setFirst = (date: Date) => setFirstMonth(monthOf(keyOf(date)));
  const second = createMemo(() => monthOf(keyOf(first()), 1));
  const shown = createMemo(() => previewRange(draft(), anchor(), preview()));
  let months: HTMLDivElement | undefined;
  const startId = createFieldMeta().controlId;
  const endId = createFieldMeta().controlId;

  const isShown = (date: Date) =>
    dates.isSameMonth(date, first(), config()) || (twoMonths() && dates.isSameMonth(date, second(), config()));

  const fill = (range: DateRangeValue) => {
    setStartText(range.start ? formatDateInput(range.start, locale()) : "");
    setEndText(range.end ? formatDateInput(range.end, locale()) : "");
    setStartError("");
    setEndError("");
  };
  const pickDay = (key: string) => {
    const next = pickRangeDay(draft(), anchor(), key);
    batch(() => {
      setDraft(next.range);
      setAnchor(next.anchor);
      setPreview(null);
      fill(next.range);
    });
  };
  /** Reads one typed half; returns the day, `null` for empty, or `undefined` after showing an error. */
  const readText = (text: string, setError: (message: string) => void): string | null | undefined => {
    const result = parseDateInput(text, { today: props.today, locale: locale() });
    if (result.kind === "empty") return null;
    if (result.kind === "error") {
      setError(errorText(result.error, locale(), inputT(), props.today));
      return undefined;
    }
    setError("");
    return result.date;
  };
  const commitTyped = () => {
    const start = readText(startText(), setStartError);
    const end = readText(endText(), setEndError);
    if (start === undefined || end === undefined) return undefined;
    const range = { start, end };
    batch(() => {
      setDraft(range);
      setAnchor(null);
    });
    if (start && end && end < start) {
      setEndError(inputT().endBeforeStart);
      return undefined;
    }
    if (start && !end) setEndError(inputT().missingEnd);
    if (end && !start) setStartError(inputT().missingStart);
    const visible = end ?? start;
    if (visible && !isShown(parseDateValue(visible, config()))) setFirstMonth(monthOf(visible, twoMonths() ? -1 : 0));
    return start && end ? { start, end } : undefined;
  };
  const complete = () => {
    const range = draft();
    return range.start && range.end && !startError() && !endError() ? { start: range.start, end: range.end } : undefined;
  };
  const apply = () => {
    const typed = commitTyped();
    if (typed) props.onApply(typed);
  };
  const fieldKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    apply();
  };
  const placeholder = () =>
    dateInputPattern(locale(), { day: inputT().dayLetters, month: inputT().monthLetters, year: inputT().yearLetters });
  const status = () => {
    const range = shown();
    return range.start && range.end ? props.rangeText({ start: range.start, end: range.end }).detail : "";
  };

  const field = (fieldProps: { id: string; label: string; text: () => string; setText: (text: string) => void; error: () => string }) => (
    <div class="k2b-field k2b-period-picker__field" data-invalid={fieldProps.error() ? "true" : undefined}>
      <label class="k2b-field__label" for={fieldProps.id}>
        {fieldProps.label}
      </label>
      <div class="k2b-input-shell">
        <input
          id={fieldProps.id}
          class="k2b-input"
          type="text"
          inputMode="numeric"
          autocomplete="off"
          spellcheck={false}
          placeholder={placeholder()}
          value={fieldProps.text()}
          aria-invalid={fieldProps.error() ? "true" : undefined}
          aria-describedby={fieldProps.error() ? `${fieldProps.id}-error` : undefined}
          onInput={(event) => fieldProps.setText(event.currentTarget.value)}
          onBlur={() => commitTyped()}
          onKeyDown={fieldKeyDown}
        />
      </div>
      <p class="k2b-period-picker__error" id={`${fieldProps.id}-error`}>
        {fieldProps.error()}
      </p>
    </div>
  );

  return (
    <div class="k2b-period-picker__editor" role="group" aria-label={t().custom}>
      <Show when={props.sheet}>
        <button type="button" class="k2b-period-picker__back" onClick={() => props.onBack()}>
          <i class="ti ti-chevron-left" aria-hidden="true" />
          {t().backToPresets}
        </button>
      </Show>
      <div class="k2b-period-picker__fields">
        {field({ id: startId, label: t().from, text: startText, setText: setStartText, error: startError })}
        {field({ id: endId, label: t().to, text: endText, setText: setEndText, error: endError })}
      </div>
      <div ref={months} class="k2b-period-picker__months">
        <DatePickerPanel
          visibleMonth={first}
          setVisibleMonth={setFirst}
          range={shown}
          focusDate={() => draft().start}
          onSelect={pickDay}
          onDayPreview={(key) => setPreview(rangeAnchor(draft(), anchor()) ? key : null)}
          dateConfig={config()}
          nav={twoMonths() ? "previous" : "both"}
          hideOutside={twoMonths()}
          isShown={isShown}
          focusRoot={() => months}
        />
        <Show when={twoMonths()}>
          <DatePickerPanel
            visibleMonth={second}
            setVisibleMonth={(date) => setFirstMonth(monthOf(keyOf(date), -1))}
            range={shown}
            focusDate={() => draft().end}
            onSelect={pickDay}
            onDayPreview={(key) => setPreview(rangeAnchor(draft(), anchor()) ? key : null)}
            dateConfig={config()}
            nav="next"
            hideOutside
            isShown={isShown}
            focusRoot={() => months}
          />
        </Show>
      </div>
      <div class="k2b-period-picker__actions">
        <span class="k2b-date-duration" aria-live="polite">
          <Show when={shown().start && shown().end}>
            <i class="ti ti-hourglass-low" aria-hidden="true" />
          </Show>
          {status()}
        </span>
        <button type="button" class="k2b-date-apply" disabled={!complete()} onClick={apply}>
          {ui().apply}
        </button>
      </div>
    </div>
  );
}

export default PeriodPicker;
