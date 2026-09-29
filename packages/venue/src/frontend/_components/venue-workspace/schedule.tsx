import {
  Button,
  type CalendarEventColor,
  CheckboxCard,
  DatePicker,
  IconButton,
  InlineGuidance,
  type IntentTone,
  PanelDialog,
  SegmentedControl,
  Select,
  TextInput,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import type {
  DateOverride,
  DateOverrideInput,
  OpeningRule,
  OpeningRuleInput,
  ShiftTemplate,
  ShiftTemplateInput,
  UpcomingSlot,
} from "../../../contracts";
import { type VenueMessages, venueMessages } from "../../../messages";
import { completeClockTime, isClockTime, isEndTime, TimeInput } from "./time-input";
import { timeZoneDateConfig, todayDateKey } from "./utils";

/** The staffing target as people read it: `2`, or `1–3` when more people may join than the shift needs. */
export const slotTarget = (slot: Pick<UpcomingSlot, "minPeople" | "maxPeople">): string =>
  slot.maxPeople && slot.maxPeople > slot.minPeople ? `${slot.minPeople}–${slot.maxPeople}` : String(slot.minPeople);

/** Below target is only urgent this close to the start, and only when the venue does not open without the shift. */
const URGENT_BEFORE_START_MS = 24 * 60 * 60_000;

export type SlotState = {
  tone: IntentTone;
  color: CalendarEventColor;
  icon: string;
  label: string;
  /** Why the state is urgent, for a tooltip or a screen reader. */
  hint?: string;
};

/**
 * A shift's staffing state in the shared tone vocabulary. Each state carries its own icon and text, so no state
 * depends on color alone: ended is neutral, a reached target success, missing people a warning, and danger only
 * for a shift that opens the venue and still lacks people within a day of its start.
 */
export const slotState = (slot: UpcomingSlot, t: VenueMessages, now = new Date()): SlotState => {
  if (new Date(slot.endsAt) < now) return { tone: "neutral", color: "zinc", icon: "ti ti-history", label: t.ended };
  if (slot.missingPeople === 0) return { tone: "success", color: "emerald", icon: "ti ti-check", label: slot.full ? t.full : t.covered };
  const label = t.missing({ count: slot.missingPeople });
  if (slot.template.requireTargetForOpening && new Date(slot.startsAt).getTime() - now.getTime() <= URGENT_BEFORE_START_MS) {
    return { tone: "danger", color: "red", icon: "ti ti-alert-triangle", label, hint: t.opensOnlyWhenStaffed };
  }
  return { tone: "warning", color: "amber", icon: "ti ti-progress", label };
};

const barTone: Record<IntentTone, string> = {
  neutral: "bg-zinc-400 dark:bg-zinc-600",
  info: "bg-blue-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

/** The state line without the bar: `0 of 1–3 staffed · 1 missing`. */
export const slotStaffingLabel = (slot: UpcomingSlot, t: VenueMessages, now = new Date()): string =>
  `${t.staffed({ assigned: slot.assignedCount, target: slotTarget(slot) })} · ${slotState(slot, t, now).label}`;

export function SlotStateLabel(props: { state: SlotState; class?: string }) {
  return (
    <span class={`inline-flex min-w-0 items-center gap-1 ${props.class ?? ""}`} title={props.state.hint}>
      <i class={`${props.state.icon} shrink-0`} aria-hidden="true" />
      <span class="truncate">{props.state.label}</span>
      <Show when={props.state.hint}>{(hint) => <span class="sr-only">{hint()}</span>}</Show>
    </span>
  );
}

export function ProgressBar(props: { slot: UpcomingSlot; compact?: boolean }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const state = () => slotState(props.slot, t());
  const total = () => props.slot.maxPeople ?? Math.max(props.slot.minPeople, props.slot.assignedCount, 1);
  const pct = () => Math.min(100, Math.round((props.slot.assignedCount / total()) * 100));
  return (
    <div>
      <Show when={!props.compact}>
        <div class="mb-1 flex flex-wrap items-center justify-between gap-x-2 text-[11px] text-dimmed">
          <span>{t().staffed({ assigned: props.slot.assignedCount, target: slotTarget(props.slot) })}</span>
          <SlotStateLabel state={state()} />
        </div>
      </Show>
      <div class={`${props.compact ? "h-1" : "h-1.5"} overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800`}>
        <div class={`h-full rounded-full ${barTone[state().tone]}`} style={{ width: `${pct()}%` }} />
      </div>
    </div>
  );
}

export function ScheduleActionButton(props: {
  label: string;
  icon: string;
  tone: "edit" | "delete";
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip.Anchor content={props.label}>
      <IconButton
        label={props.label}
        size="xs"
        variant="ghost"
        class={props.tone === "edit" ? "text-blue-600 dark:text-blue-400" : "text-red-600 dark:text-red-400"}
        loading={props.loading}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        <i class={props.icon} aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );
}

export function DialogFrame(props: {
  title: string;
  subtitle?: string;
  icon: string;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  /** While the dialog saves: the submit button shows progress and the dialog cannot be closed. */
  pending?: boolean;
  /** Why the last save failed, when no single field is to blame. */
  error?: string | null;
  children: JSX.Element;
}) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const cancel = () => {
    if (!props.pending) props.onCancel();
  };
  return (
    <PanelDialog>
      <form
        class="flex min-h-0 flex-1 flex-col overflow-hidden"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.pending) props.onSubmit();
        }}
      >
        <PanelDialog.Header title={props.title} subtitle={props.subtitle} icon={props.icon} close={cancel} />
        <PanelDialog.Body>
          <div class="grid gap-3">
            {props.children}
            <Show when={props.error}>
              {(error) => (
                <InlineGuidance tone="danger" icon="ti ti-alert-circle">
                  {error()}
                </InlineGuidance>
              )}
            </Show>
          </div>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <div />
          <div class="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={props.pending} onClick={cancel}>
              {t().cancel}
            </Button>
            <Button type="submit" size="sm" loading={props.pending} loadingLabel={props.submitLabel}>
              {props.submitLabel}
            </Button>
          </div>
        </PanelDialog.Footer>
      </form>
    </PanelDialog>
  );
}

/**
 * Saves a dialog's value and answers `null` once the server confirmed it, or why it did not. The dialog stays
 * open with its input until the save succeeds.
 */
export type DialogSubmit<T> = (value: T) => Promise<string | null>;

/** A dialog that saves through {@link DialogSubmit}: it closes with `true` after a confirmed save. */
export type SubmittingDialogProps<T> = {
  submit: DialogSubmit<T>;
  close: (saved: boolean) => void;
  /** Receives the dialog's Escape and backdrop handler, which does nothing while a save runs. */
  guardDismiss?: (handler: () => void) => void;
};

/** Runs `submit` once at a time and keeps its outcome for the dialog. */
export const createDialogSave = <T,>(props: SubmittingDialogProps<T>) => {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  props.guardDismiss?.(() => {
    if (!pending()) props.close(false);
  });
  const save = async (value: T) => {
    if (pending()) return;
    setPending(true);
    setError(null);
    try {
      const failure = await props.submit(value);
      if (failure === null) props.close(true);
      else setError(failure);
    } finally {
      setPending(false);
    }
  };
  return { pending, error, save };
};

/** Weekday names in the reader's locale, Monday first as in the calendar. */
const WEEKDAYS_FROM_MONDAY = [1, 2, 3, 4, 5, 6, 0] as const;
const weekdayName = (weekday: number, locale: string, width: "long" | "short") =>
  new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + weekday)));
const weekdayOptions = (locale: string) =>
  WEEKDAYS_FROM_MONDAY.map((weekday) => ({ id: String(weekday), label: weekdayName(weekday, locale, "long") }));

type TimeErrors = { startTime?: string; endTime?: string };

/** Field errors for a start and end time on the same day; the end must come after the start and may be 24:00. */
const timeRangeErrors = (startTime: string, endTime: string, t: VenueMessages): TimeErrors => {
  const errors: TimeErrors = {};
  if (!startTime.trim()) errors.startTime = t.timeRequired;
  else if (!isClockTime(startTime.trim())) errors.startTime = t.timeInvalid;
  if (!endTime.trim()) errors.endTime = t.timeRequired;
  else if (!isEndTime(endTime.trim())) errors.endTime = t.timeInvalid;
  else if (!errors.startTime && endTime.trim() <= startTime.trim()) errors.endTime = t.endAfterStart;
  return errors;
};

const hasErrors = (errors: Record<string, string | undefined>) => Object.values(errors).some(Boolean);

export function OpeningRuleDialog(props: SubmittingDialogProps<OpeningRuleInput> & { initial?: OpeningRule }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const dialog = createDialogSave(props);
  const [weekday, setWeekday] = createSignal(String(props.initial?.weekday ?? 1));
  const [startTime, setStartTime] = createSignal(props.initial?.startTime ?? "09:00");
  const [endTime, setEndTime] = createSignal(props.initial?.endTime ?? "17:00");
  const [note, setNote] = createSignal(props.initial?.note ?? "");
  // Fields say what is wrong only after the first attempt to save, not while someone is still typing.
  const [attempted, setAttempted] = createSignal(false);
  const errors = () => (attempted() ? timeRangeErrors(startTime(), endTime(), t()) : {});

  const submit = () => {
    // Enter can submit before the time field completes its input on blur.
    setStartTime(completeClockTime(startTime()));
    setEndTime(completeClockTime(endTime()));
    setAttempted(true);
    if (hasErrors(errors())) return;
    void dialog.save({
      weekday: Number(weekday()),
      startTime: startTime().trim(),
      endTime: endTime().trim(),
      note: note().trim() || null,
    });
  };

  return (
    <DialogFrame
      title={props.initial ? t().editOpening : t().addOpening}
      icon="ti ti-clock"
      submitLabel={props.initial ? t().save : t().add}
      onCancel={() => props.close(false)}
      onSubmit={submit}
      pending={dialog.pending()}
      error={dialog.error()}
    >
      <Select label={t().weekday} value={weekday} onValueChange={(value) => setWeekday(value ?? "1")} options={weekdayOptions(locale())} />
      <div class="grid gap-3 sm:grid-cols-2">
        <TimeInput label={t().startTime} value={startTime()} onValueChange={setStartTime} placeholder="09:00" error={errors().startTime} />
        <TimeInput label={t().endTime} value={endTime()} onValueChange={setEndTime} placeholder="17:00" error={errors().endTime} />
      </div>
      <TextInput label={t().note} description={t().publicNoteDescription} value={note} onValueChange={setNote} placeholder={t().optional} />
    </DialogFrame>
  );
}

/**
 * Adds or edits an exception for one date: closed all day, or a special opening with its own times that replace
 * the day's regular hours. The kind is an explicit choice, so saving never changes it by accident. A date in
 * `takenDates` already has another exception; the date field says so instead of replacing that one.
 */
export function ExceptionDialog(
  props: SubmittingDialogProps<DateOverrideInput> & {
    timeZone: string;
    initial?: DateOverride;
    today?: string;
    takenDates?: readonly string[];
  },
) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const dialog = createDialogSave(props);
  const [kind, setKind] = createSignal<DateOverride["kind"]>(props.initial?.kind ?? "closed");
  const [date, setDate] = createSignal<string | null>(props.initial?.date ?? props.today ?? todayDateKey());
  const [startTime, setStartTime] = createSignal(props.initial?.startTime ?? "18:00");
  const [endTime, setEndTime] = createSignal(props.initial?.endTime ?? "22:00");
  const [note, setNote] = createSignal(props.initial?.note ?? "");
  const [attempted, setAttempted] = createSignal(false);
  const errors = (): TimeErrors & { date?: string } => {
    if (!attempted()) return {};
    const day = date();
    return {
      date: !day ? t().pickDate : props.takenDates?.includes(day) ? t().exceptionDateTaken : undefined,
      ...(kind() === "open" ? timeRangeErrors(startTime(), endTime(), t()) : {}),
    };
  };

  const submit = () => {
    // Enter can submit before the time field completes its input on blur.
    setStartTime(completeClockTime(startTime()));
    setEndTime(completeClockTime(endTime()));
    setAttempted(true);
    const day = date();
    if (hasErrors(errors()) || !day) return;
    const trimmedNote = note().trim() || null;
    void dialog.save(
      kind() === "open"
        ? { date: day, kind: "open", startTime: startTime().trim(), endTime: endTime().trim(), note: trimmedNote }
        : { date: day, kind: "closed", note: trimmedNote },
    );
  };

  return (
    <DialogFrame
      title={props.initial ? t().editException : t().addException}
      icon={kind() === "open" ? "ti ti-calendar-plus" : "ti ti-calendar-off"}
      submitLabel={props.initial ? t().save : t().add}
      onCancel={() => props.close(false)}
      onSubmit={submit}
      pending={dialog.pending()}
      error={dialog.error()}
    >
      <SegmentedControl<DateOverride["kind"]>
        ariaLabel={t().exceptionKind}
        value={kind}
        onValueChange={setKind}
        options={[
          { value: "closed", label: t().closed, icon: "ti ti-calendar-off" },
          { value: "open", label: t().specialOpeningKind, icon: "ti ti-calendar-plus" },
        ]}
      />
      <p class="text-xs text-dimmed">{kind() === "open" ? t().specialOpeningHint : t().closedDayHint}</p>
      <DatePicker
        label={t().date}
        value={date}
        onValueChange={setDate}
        dateConfig={timeZoneDateConfig(props.timeZone, locale())}
        error={() => errors().date}
        required
      />
      <Show when={kind() === "open"}>
        <div class="grid gap-3 sm:grid-cols-2">
          <TimeInput
            label={t().startTime}
            value={startTime()}
            onValueChange={setStartTime}
            placeholder="18:00"
            error={errors().startTime}
          />
          <TimeInput label={t().endTime} value={endTime()} onValueChange={setEndTime} placeholder="22:00" error={errors().endTime} />
        </div>
      </Show>
      <TextInput
        label={t().note}
        description={t().publicNoteDescription}
        value={note}
        onValueChange={setNote}
        placeholder={kind() === "open" ? t().specialOpeningNotePlaceholder : t().publicHoliday}
      />
    </DialogFrame>
  );
}

type ShiftTemplateDraft = {
  title: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  minPeople: string;
  maxPeople: string;
  requireTargetForOpening: boolean;
  active: boolean;
};

type ShiftTemplateErrors = {
  title?: string;
  weekdays?: string;
  startTime?: string;
  endTime?: string;
  minPeople?: string;
  maxPeople?: string;
};

const WHOLE_NUMBER = /^\d+$/;

/**
 * Checks a shift draft field by field and builds one template per chosen weekday, in calendar order, when every
 * field is valid. The server applies the same rules.
 */
const buildShiftTemplates = (
  draft: ShiftTemplateDraft,
  t: VenueMessages,
): { inputs: ShiftTemplateInput[]; errors: ShiftTemplateErrors } => {
  const title = draft.title.trim();
  const min = draft.minPeople.trim();
  const max = draft.maxPeople.trim();
  const errors: ShiftTemplateErrors = {
    title: title ? undefined : t.titleRequired,
    weekdays: draft.weekdays.length > 0 ? undefined : t.pickWeekday,
    ...timeRangeErrors(draft.startTime, draft.endTime, t),
    minPeople: WHOLE_NUMBER.test(min) ? undefined : t.peopleInvalid,
    maxPeople: max && !WHOLE_NUMBER.test(max) ? t.peopleInvalid : undefined,
  };
  if (!errors.minPeople && !errors.maxPeople) {
    if (max && Number(max) < Number(min)) errors.maxPeople = t.shiftValidationMaximum;
    if (draft.requireTargetForOpening && Number(min) < 1) errors.minPeople = t.shiftValidationTarget;
  }
  if (hasErrors(errors)) return { inputs: [], errors };
  const weekdays = WEEKDAYS_FROM_MONDAY.filter((weekday) => draft.weekdays.includes(weekday));
  return {
    inputs: weekdays.map((weekday) => ({
      title,
      weekday,
      startTime: draft.startTime.trim(),
      endTime: draft.endTime.trim(),
      minPeople: Number(min),
      maxPeople: max ? Number(max) : null,
      requireTargetForOpening: draft.requireTargetForOpening,
      active: draft.active,
    })),
    errors,
  };
};

/**
 * Creates a shift on one or several weekdays at once, as one template per weekday, or edits one template. Its
 * weekday stays a single choice when editing, because every weekday is a template of its own.
 */
export function ShiftTemplateDialog(props: SubmittingDialogProps<ShiftTemplateInput[]> & { initial?: ShiftTemplate }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const dialog = createDialogSave(props);
  const [title, setTitle] = createSignal(props.initial?.title ?? "");
  const [weekdays, setWeekdays] = createSignal<number[]>([props.initial?.weekday ?? 1]);
  const [startTime, setStartTime] = createSignal(props.initial?.startTime ?? "09:00");
  const [endTime, setEndTime] = createSignal(props.initial?.endTime ?? "13:00");
  const [minPeople, setMinPeople] = createSignal(String(props.initial?.minPeople ?? 1));
  const [maxPeople, setMaxPeople] = createSignal(props.initial?.maxPeople == null ? "" : String(props.initial.maxPeople));
  const [requireTargetForOpening, setRequireTargetForOpening] = createSignal(props.initial?.requireTargetForOpening ?? false);
  const [attempted, setAttempted] = createSignal(false);
  const result = () =>
    buildShiftTemplates(
      {
        title: title(),
        weekdays: weekdays(),
        startTime: startTime(),
        endTime: endTime(),
        minPeople: minPeople(),
        maxPeople: maxPeople(),
        requireTargetForOpening: requireTargetForOpening(),
        active: props.initial?.active ?? true,
      },
      t(),
    );
  const errors = (): ShiftTemplateErrors => (attempted() ? result().errors : {});
  const toggleWeekday = (weekday: number, checked: boolean) =>
    setWeekdays((current) => (checked ? [...new Set([...current, weekday])] : current.filter((entry) => entry !== weekday)));
  const count = () => weekdays().length;

  const submit = () => {
    // Enter can submit before the time field completes its input on blur.
    setStartTime(completeClockTime(startTime()));
    setEndTime(completeClockTime(endTime()));
    setAttempted(true);
    const { inputs } = result();
    if (inputs.length > 0) void dialog.save(inputs);
  };

  return (
    <DialogFrame
      title={props.initial ? t().editShift : t().addShift}
      icon="ti ti-calendar-plus"
      submitLabel={props.initial ? t().save : count() > 1 ? t().addShifts({ count: count() }) : t().add}
      onCancel={() => props.close(false)}
      onSubmit={submit}
      pending={dialog.pending()}
      error={dialog.error()}
    >
      <TextInput
        label={t().title}
        value={title}
        onValueChange={setTitle}
        placeholder={t().morningShift}
        error={() => errors().title}
        required
      />
      <Show
        when={!props.initial}
        fallback={
          <Select
            label={t().weekday}
            value={() => String(weekdays()[0] ?? 1)}
            onValueChange={(value) => setWeekdays([Number(value ?? 1)])}
            options={weekdayOptions(locale())}
          />
        }
      >
        <fieldset class="k2b-field" data-invalid={errors().weekdays ? "true" : undefined} data-shift-weekdays="">
          <legend class="k2b-field__label">{t().weekdays}</legend>
          <p class="k2b-field__description">{t().weekdaysDescription}</p>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <For each={WEEKDAYS_FROM_MONDAY}>
              {(weekday) => (
                <CheckboxCard
                  label={
                    <>
                      <span aria-hidden="true">{weekdayName(weekday, locale(), "short")}</span>
                      <span class="sr-only">{weekdayName(weekday, locale(), "long")}</span>
                    </>
                  }
                  value={() => weekdays().includes(weekday)}
                  onValueChange={(checked) => toggleWeekday(weekday, checked)}
                  variant="input"
                />
              )}
            </For>
          </div>
          <Show when={errors().weekdays}>
            {(error) => (
              <p class="k2b-field__error" role="alert" aria-live="polite">
                {error()}
              </p>
            )}
          </Show>
        </fieldset>
      </Show>
      <div class="grid gap-3 sm:grid-cols-2">
        <TimeInput label={t().startTime} value={startTime()} onValueChange={setStartTime} placeholder="09:00" error={errors().startTime} />
        <TimeInput label={t().endTime} value={endTime()} onValueChange={setEndTime} placeholder="13:00" error={errors().endTime} />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <TextInput
          label={t().targetPeople}
          value={minPeople}
          onValueChange={setMinPeople}
          inputMode="numeric"
          error={() => errors().minPeople}
          required
        />
        <TextInput
          label={t().maxPeople}
          value={maxPeople}
          onValueChange={setMaxPeople}
          inputMode="numeric"
          placeholder={t().optional}
          error={() => errors().maxPeople}
        />
      </div>
      <CheckboxCard
        label={t().requireTarget}
        description={t().requireTargetDescription}
        icon="ti ti-users-check"
        value={requireTargetForOpening}
        onValueChange={setRequireTargetForOpening}
        variant="input"
      />
    </DialogFrame>
  );
}
