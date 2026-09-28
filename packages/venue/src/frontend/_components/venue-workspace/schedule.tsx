import {
  Button,
  type CalendarEventColor,
  CheckboxCard,
  DatePicker,
  IconButton,
  type IntentTone,
  PanelDialog,
  prompts,
  Select,
  TextInput,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
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
        onClick={props.onClick}
      >
        <i class={props.loading ? "ti ti-loader-2 animate-spin" : props.icon} />
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
  children: JSX.Element;
}) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  return (
    <PanelDialog>
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PanelDialog.Header title={props.title} subtitle={props.subtitle} icon={props.icon} close={props.onCancel} />
        <PanelDialog.Body>{props.children}</PanelDialog.Body>
        <PanelDialog.Footer>
          <div />
          <div class="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={props.onCancel}>
              {t().cancel}
            </Button>
            <Button type="button" size="sm" onClick={props.onSubmit}>
              {props.submitLabel}
            </Button>
          </div>
        </PanelDialog.Footer>
      </div>
    </PanelDialog>
  );
}

export function OpeningRuleDialog(props: { close: (value: OpeningRuleInput | null) => void; initial?: OpeningRule }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const weekdayOptions = () =>
    Array.from({ length: 7 }, (_, weekday) => ({
      id: String(weekday),
      label: new Intl.DateTimeFormat(locale(), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + weekday))),
    }));
  const [weekday, setWeekday] = createSignal(String(props.initial?.weekday ?? 1));
  const [startTime, setStartTime] = createSignal(props.initial?.startTime ?? "09:00");
  const [endTime, setEndTime] = createSignal(props.initial?.endTime ?? "17:00");
  const [note, setNote] = createSignal(props.initial?.note ?? "");

  const submit = () => {
    if (!startTime().trim() || !endTime().trim()) {
      prompts.error(t().timesRequired);
      return;
    }
    props.close({
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
      onCancel={() => props.close(null)}
      onSubmit={submit}
    >
      <div class="grid gap-3">
        <Select label={t().weekday} value={weekday} onValueChange={setWeekday} options={weekdayOptions()} />
        <div class="grid gap-3 sm:grid-cols-2">
          <TextInput
            label={t().startTime}
            value={startTime}
            onValueChange={setStartTime}
            placeholder="09:00"
            inputMode="numeric"
            required
          />
          <TextInput label={t().endTime} value={endTime} onValueChange={setEndTime} placeholder="17:00" inputMode="numeric" required />
        </div>
        <TextInput label={t().note} value={note} onValueChange={setNote} placeholder={t().optional} />
      </div>
    </DialogFrame>
  );
}

export function ClosedDayDialog(props: { close: (value: DateOverrideInput | null) => void; timeZone: string; initial?: DateOverride }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [date, setDate] = createSignal<string | null>(props.initial?.date ?? todayDateKey());
  const [note, setNote] = createSignal(props.initial?.note ?? t().publicHoliday);

  const submit = () => {
    if (!date()) {
      prompts.error(t().pickDate);
      return;
    }
    props.close({ date: date()!, kind: "closed", note: note().trim() || t().publicHoliday });
  };

  return (
    <DialogFrame
      title={props.initial ? t().editClosedDay : t().addClosedDay}
      icon="ti ti-calendar-x"
      submitLabel={props.initial ? t().save : t().add}
      onCancel={() => props.close(null)}
      onSubmit={submit}
    >
      <div class="grid gap-3">
        <DatePicker
          label={t().date}
          value={date}
          onValueChange={setDate}
          dateConfig={timeZoneDateConfig(props.timeZone, locale())}
          required
        />
        <TextInput label={t().note} value={note} onValueChange={setNote} placeholder={t().publicHoliday} />
      </div>
    </DialogFrame>
  );
}

type ShiftTemplateDraft = {
  title: string;
  weekday: string;
  startTime: string;
  endTime: string;
  minPeople: string;
  maxPeople: string;
  requireTargetForOpening: boolean;
  active: boolean;
};

const parseOptionalPeople = (value: string): number | null => {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
};

const parseRequiredPeople = (value: string): number => Number(value.trim() || "1");

const buildShiftTemplateInput = (
  draft: ShiftTemplateDraft,
  t: VenueMessages,
): { input: ShiftTemplateInput; error: null } | { input: null; error: string } => {
  const title = draft.title.trim();
  const startTime = draft.startTime.trim();
  const endTime = draft.endTime.trim();
  const min = parseRequiredPeople(draft.minPeople);
  const max = parseOptionalPeople(draft.maxPeople);

  if (!title || !startTime || !endTime || Number.isNaN(min) || (max !== null && Number.isNaN(max))) {
    return { input: null, error: t.shiftValidationRequired };
  }
  if (min < 0 || (max !== null && max < 0)) return { input: null, error: t.shiftValidationNegative };
  if (max !== null && max < min) return { input: null, error: t.shiftValidationMaximum };
  if (draft.requireTargetForOpening && min < 1) {
    return { input: null, error: t.shiftValidationTarget };
  }

  return {
    input: {
      title,
      weekday: Number(draft.weekday),
      startTime,
      endTime,
      minPeople: min,
      maxPeople: max,
      requireTargetForOpening: draft.requireTargetForOpening,
      active: draft.active,
    },
    error: null,
  };
};

export function ShiftTemplateDialog(props: { close: (value: ShiftTemplateInput | null) => void; initial?: ShiftTemplate }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const weekdayOptions = () =>
    Array.from({ length: 7 }, (_, weekday) => ({
      id: String(weekday),
      label: new Intl.DateTimeFormat(locale(), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + weekday))),
    }));
  const [title, setTitle] = createSignal(props.initial?.title ?? "");
  const [weekday, setWeekday] = createSignal(String(props.initial?.weekday ?? 1));
  const [startTime, setStartTime] = createSignal(props.initial?.startTime ?? "09:00");
  const [endTime, setEndTime] = createSignal(props.initial?.endTime ?? "13:00");
  const [minPeople, setMinPeople] = createSignal(String(props.initial?.minPeople ?? 1));
  const [maxPeople, setMaxPeople] = createSignal(props.initial?.maxPeople == null ? "" : String(props.initial.maxPeople));
  const [requireTargetForOpening, setRequireTargetForOpening] = createSignal(props.initial?.requireTargetForOpening ?? false);

  const submit = () => {
    const result = buildShiftTemplateInput(
      {
        title: title(),
        weekday: weekday(),
        startTime: startTime(),
        endTime: endTime(),
        minPeople: minPeople(),
        maxPeople: maxPeople(),
        requireTargetForOpening: requireTargetForOpening(),
        active: props.initial?.active ?? true,
      },
      t(),
    );
    if (result.error) {
      prompts.error(result.error);
      return;
    }
    props.close(result.input);
  };

  return (
    <DialogFrame
      title={props.initial ? t().editShift : t().addShift}
      icon="ti ti-calendar-plus"
      submitLabel={props.initial ? t().save : t().add}
      onCancel={() => props.close(null)}
      onSubmit={submit}
    >
      <div class="grid gap-3">
        <TextInput label={t().title} value={title} onValueChange={setTitle} placeholder={t().morningShift} required />
        <Select label={t().weekday} value={weekday} onValueChange={setWeekday} options={weekdayOptions()} />
        <div class="grid gap-3 sm:grid-cols-2">
          <TextInput
            label={t().startTime}
            value={startTime}
            onValueChange={setStartTime}
            placeholder="09:00"
            inputMode="numeric"
            required
          />
          <TextInput label={t().endTime} value={endTime} onValueChange={setEndTime} placeholder="13:00" inputMode="numeric" required />
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <TextInput label={t().targetPeople} value={minPeople} onValueChange={setMinPeople} inputMode="numeric" required />
          <TextInput label={t().maxPeople} value={maxPeople} onValueChange={setMaxPeople} inputMode="numeric" placeholder={t().optional} />
        </div>
        <CheckboxCard
          label={t().requireTarget}
          description={t().requireTargetDescription}
          icon="ti ti-users-check"
          value={requireTargetForOpening}
          onValueChange={setRequireTargetForOpening}
          variant="input"
        />
      </div>
    </DialogFrame>
  );
}
