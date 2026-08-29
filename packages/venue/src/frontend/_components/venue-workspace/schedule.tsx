import { Button, CheckboxCard, DatePicker, IconButton, PanelDialog, prompts, Select, TextInput, Tooltip, useLocale } from "@k2b/ui";
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
import { venueMessages, type VenueMessages } from "../../../messages";
import { timeZoneDateConfig, todayDateKey } from "./utils";

export function ProgressBar(props: { slot: UpcomingSlot; compact?: boolean }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const total = () => props.slot.maxPeople ?? Math.max(props.slot.minPeople, props.slot.assignedCount, 1);
  const pct = () => Math.min(100, Math.round((props.slot.assignedCount / total()) * 100));
  return (
    <div>
      <Show when={!props.compact}>
        <div class="mb-1 flex items-center justify-between text-[11px] text-dimmed">
          <span>{t().staffed({ assigned: props.slot.assignedCount, total: props.slot.maxPeople ?? props.slot.minPeople })}</span>
          <span>{props.slot.missingPeople > 0 ? t().missing({ count: props.slot.missingPeople }) : t().covered}</span>
        </div>
      </Show>
      <div class={`${props.compact ? "h-1" : "h-1.5"} overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800`}>
        <div
          class={`h-full rounded-full ${props.slot.missingPeople > 0 ? "bg-amber-500" : "bg-emerald-500"}`}
          style={{ width: `${pct()}%` }}
        />
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
