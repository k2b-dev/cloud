import { Button, CheckboxCard, DatePicker, DateRangePicker, IconButton, Select, Switch, TextInput, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { validateResponseScheduleDefinition } from "../../response-schedule-validation";
import type { ResponseScheduleDefinition } from "../../service/response-schedule";
import { mailRemainingMessages } from "./mail-remaining-messages";

type WindowedResponseScheduleDefinition = Extract<ResponseScheduleDefinition, { mode: "windows" }>;

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const timeZones = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
})();

const today = (): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

type Window = { start: string; end: string };
type Weekday = (typeof WEEKDAYS)[number];
const DEFAULT_WINDOW: Window = { start: "09:00", end: "17:00" };
const FULL_DAY_WINDOW: Window = { start: "00:00", end: "24:00" };

const isFullDayWindow = (windows: readonly Window[]): boolean =>
  windows.length === 1 && windows[0]?.start === FULL_DAY_WINDOW.start && windows[0]?.end === FULL_DAY_WINDOW.end;

function WindowEditor(props: { windows: () => Window[]; onChange: (windows: Window[]) => void; addLabel: string; compact?: boolean }) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const update = (index: number, field: keyof Window, value: string) =>
    props.onChange(props.windows().map((window, position) => (position === index ? { ...window, [field]: value } : window)));
  return (
    <div class="flex flex-col gap-2">
      <For each={props.windows()}>
        {(window, index) => (
          <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-end gap-2">
            <TextInput
              label={!props.compact && index() === 0 ? messages().from : undefined}
              aria-label={messages().windowStart({ index: index() + 1 })}
              value={() => window.start}
              onValueChange={(value) => update(index(), "start", value)}
              placeholder="09:00"
              icon="ti ti-clock"
              maxLength={5}
              monospace
            />
            <TextInput
              label={!props.compact && index() === 0 ? messages().until : undefined}
              aria-label={messages().windowEnd({ index: index() + 1 })}
              value={() => window.end}
              onValueChange={(value) => update(index(), "end", value)}
              placeholder="17:00"
              icon="ti ti-clock"
              maxLength={5}
              monospace
            />
            <IconButton
              type="button"
              class={props.compact ? undefined : "mb-0.5"}
              label={messages().removeWindow({ index: index() + 1 })}
              onClick={() => props.onChange(props.windows().filter((_, position) => position !== index()))}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </For>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="self-start"
        onClick={() => props.onChange([...props.windows(), { ...DEFAULT_WINDOW }])}
      >
        <i class="ti ti-plus" aria-hidden="true" /> {props.addLabel}
      </Button>
    </div>
  );
}

function WindowedResponseScheduleFields(props: {
  value: () => WindowedResponseScheduleDefinition;
  onChange: (value: WindowedResponseScheduleDefinition) => void;
  errors?: () => string[];
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const previousDayWindows = new Map<Weekday, Window[]>();
  const errors = createMemo(() => props.errors?.() ?? validateResponseScheduleDefinition(props.value()));
  const update = <K extends keyof WindowedResponseScheduleDefinition>(key: K, value: WindowedResponseScheduleDefinition[K]) =>
    props.onChange({ ...props.value(), [key]: value });
  const windowsForDay = (weekday: (typeof WEEKDAYS)[number]) => props.value().weeklyWindows.filter((window) => window.weekday === weekday);
  const setDayWindows = (weekday: (typeof WEEKDAYS)[number], windows: Window[]) =>
    update("weeklyWindows", [
      ...props.value().weeklyWindows.filter((window) => window.weekday !== weekday),
      ...windows.map((window) => ({ ...window, weekday })),
    ]);
  const setDayEnabled = (weekday: Weekday, enabled: boolean) => {
    const windows = windowsForDay(weekday).map(({ start, end }) => ({ start, end }));
    if (!enabled) {
      if (windows.length === 0) return;
      previousDayWindows.set(weekday, windows);
      setDayWindows(weekday, []);
      return;
    }
    if (windows.length > 0) return;
    setDayWindows(
      weekday,
      (previousDayWindows.get(weekday) ?? [{ ...DEFAULT_WINDOW }]).map((window) => ({ ...window })),
    );
  };
  const setAllDay = (weekday: Weekday, allDay: boolean) => {
    const windows = windowsForDay(weekday).map(({ start, end }) => ({ start, end }));
    if (allDay) {
      if (!isFullDayWindow(windows)) previousDayWindows.set(weekday, windows);
      setDayWindows(weekday, [{ ...FULL_DAY_WINDOW }]);
      return;
    }
    setDayWindows(
      weekday,
      (previousDayWindows.get(weekday) ?? [{ ...DEFAULT_WINDOW }]).map((window) => ({ ...window })),
    );
  };

  return (
    <div class="flex flex-col gap-2">
      <Show when={errors().length > 0}>
        <div class="flex gap-2 rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <i class="ti ti-alert-circle mt-0.5 shrink-0" aria-hidden="true" />
          <div>
            <For each={errors()}>{(error) => <p>{error}</p>}</For>
          </div>
        </div>
      </Show>
      <Select
        label={messages().timeZone({ timeZone: "" }).split(":")[0]}
        description={messages().scheduleTimeZoneDescription}
        icon="ti ti-world"
        value={() => props.value().timeZone}
        selectedLabel={() => props.value().timeZone}
        fetchDebounceMs={0}
        fetchData={async (query) => {
          const normalized = query.trim().toLowerCase();
          return timeZones
            .filter((zone) => !normalized || zone.toLowerCase().includes(normalized))
            .slice(0, 100)
            .map((zone) => ({ id: zone, label: zone }));
        }}
        onValueChange={(timeZone) => update("timeZone", timeZone ?? props.value().timeZone)}
      />

      <div>
        <div class="mb-2 flex items-start justify-between gap-3">
          <div>
            <p class="text-sm font-medium text-primary">{messages().activeDateRanges}</p>
            <p class="text-xs text-dimmed">{messages().activeDateRangesDescription}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class="shrink-0"
            onClick={() => update("activeRanges", [...props.value().activeRanges, { from: today(), to: null }])}
          >
            <i class="ti ti-plus" aria-hidden="true" /> {messages().addRange}
          </Button>
        </div>
        <Show when={props.value().activeRanges.length > 0} fallback={<p class="text-xs text-dimmed">{messages().noDateLimit}</p>}>
          <div class="flex flex-col gap-2">
            <For each={props.value().activeRanges}>
              {(range, index) => (
                <div class="grid grid-cols-[minmax(0,1fr)_2rem] items-end gap-2">
                  <DateRangePicker
                    label={index() === 0 ? messages().range : undefined}
                    value={() => ({ start: range.from, end: range.to })}
                    onValueChange={(value) =>
                      update(
                        "activeRanges",
                        props
                          .value()
                          .activeRanges.map((item, position) =>
                            position === index() ? { from: value.start ?? item.from, to: value.end } : item,
                          ),
                      )
                    }
                  />
                  <IconButton
                    type="button"
                    class="mb-0.5"
                    label={messages().removeDateRange({ index: index() + 1 })}
                    onClick={() =>
                      update(
                        "activeRanges",
                        props.value().activeRanges.filter((_, position) => position !== index()),
                      )
                    }
                  >
                    <i class="ti ti-x" aria-hidden="true" />
                  </IconButton>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div>
        <div class="mb-2">
          <div>
            <p class="text-sm font-medium text-primary">{messages().weeklyHours}</p>
            <p class="text-xs text-dimmed">{messages().weeklyHoursDescription}</p>
          </div>
        </div>
        <div class="flex flex-col gap-2">
          <For each={WEEKDAYS}>
            {(day) => {
              const windows = () => windowsForDay(day);
              const active = () => windows().length > 0;
              const allDay = () => isFullDayWindow(windows());
              const dayDescription = () => {
                if (!active()) return messages().disabled;
                if (allDay()) return messages().allDay;
                return messages().windows({ count: windows().length });
              };
              return (
                <div class="grid gap-2 md:grid-cols-[12rem_7rem_minmax(0,1fr)] md:items-start">
                  <CheckboxCard
                    label={messages().weekday({ day })}
                    description={dayDescription()}
                    icon={active() ? "ti ti-calendar-check" : "ti ti-calendar-off"}
                    variant="input"
                    value={active}
                    onValueChange={(enabled) => setDayEnabled(day, enabled)}
                  />
                  <Show when={active()}>
                    <div class="flex min-h-12 items-center md:justify-center">
                      <Switch label={messages().allDay} value={allDay} onValueChange={(value) => setAllDay(day, value)} />
                    </div>
                    <div class="min-w-0">
                      <Show
                        when={!allDay()}
                        fallback={<div class="flex min-h-12 items-center font-mono text-xs text-dimmed">00:00–24:00</div>}
                      >
                        <WindowEditor
                          windows={windows}
                          onChange={(next) => setDayWindows(day, next)}
                          addLabel={messages().addAnotherWindow}
                          compact
                        />
                      </Show>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>

      <div>
        <div class="mb-2 flex items-start justify-between gap-3">
          <div>
            <p class="text-sm font-medium text-primary">{messages().dateExceptions}</p>
            <p class="text-xs text-dimmed">{messages().dateExceptionsDescription}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class="shrink-0"
            onClick={() => update("exceptions", [...props.value().exceptions, { date: today(), closed: true, windows: [] }])}
          >
            <i class="ti ti-plus" aria-hidden="true" /> {messages().addException}
          </Button>
        </div>
        <Show when={props.value().exceptions.length > 0} fallback={<p class="text-xs text-dimmed">{messages().noExceptions}</p>}>
          <div class="flex flex-col gap-2">
            <For each={props.value().exceptions}>
              {(exception, index) => {
                const replace = (next: typeof exception) =>
                  update(
                    "exceptions",
                    props.value().exceptions.map((item, position) => (position === index() ? next : item)),
                  );
                return (
                  <div class="flex flex-col gap-2 py-3">
                    <div class="grid grid-cols-[minmax(0,1fr)_auto_2rem] items-end gap-2">
                      <DatePicker
                        label={messages().date}
                        value={() => exception.date}
                        onValueChange={(date) => date && replace({ ...exception, date })}
                      />
                      <div class="mb-0.5 flex h-10 items-center">
                        <Switch
                          label={messages().disabled}
                          value={() => exception.closed}
                          onValueChange={(closed) =>
                            replace({
                              ...exception,
                              closed,
                              windows: closed ? [] : exception.windows.length > 0 ? exception.windows : [{ start: "09:00", end: "17:00" }],
                            })
                          }
                        />
                      </div>
                      <IconButton
                        type="button"
                        class="mb-0.5"
                        label={messages().removeException({ index: index() + 1 })}
                        onClick={() =>
                          update(
                            "exceptions",
                            props.value().exceptions.filter((_, position) => position !== index()),
                          )
                        }
                      >
                        <i class="ti ti-trash" aria-hidden="true" />
                      </IconButton>
                    </div>
                    <Show when={!exception.closed}>
                      <WindowEditor
                        windows={() => exception.windows}
                        onChange={(windows) => replace({ ...exception, windows })}
                        addLabel={messages().addHours}
                      />
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

const defaultWindowedSchedule = (): WindowedResponseScheduleDefinition => ({
  mode: "windows",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  activeRanges: [],
  weeklyWindows: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday: weekday as Weekday,
    ...DEFAULT_WINDOW,
  })),
  exceptions: [],
});

export default function MailResponseScheduleFields(props: {
  value: () => ResponseScheduleDefinition;
  onChange: (value: ResponseScheduleDefinition) => void;
  errors?: () => string[];
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const initialValue = props.value();
  let previousWindowedSchedule: WindowedResponseScheduleDefinition | null = initialValue.mode === "windows" ? initialValue : null;
  const windowedSchedule = (): WindowedResponseScheduleDefinition | null => {
    const value = props.value();
    return value.mode === "windows" ? value : null;
  };
  const setWindowedSchedule = (value: WindowedResponseScheduleDefinition) => {
    previousWindowedSchedule = value;
    props.onChange(value);
  };
  const setAlways = (always: boolean) => {
    if (always) {
      const current = windowedSchedule();
      if (current) previousWindowedSchedule = current;
      props.onChange({ mode: "always" });
      return;
    }
    setWindowedSchedule(previousWindowedSchedule ?? defaultWindowedSchedule());
  };

  return (
    <div class="flex flex-col gap-3">
      <CheckboxCard
        label={messages().alwaysOn}
        description={messages().alwaysOnDescription}
        icon="ti ti-clock-24"
        variant="input"
        value={() => props.value().mode === "always"}
        onValueChange={setAlways}
      />
      <Show when={windowedSchedule()}>
        {(schedule) => <WindowedResponseScheduleFields value={schedule} onChange={setWindowedSchedule} errors={props.errors} />}
      </Show>
    </div>
  );
}

export const responseScheduleSummary = (definition: ResponseScheduleDefinition, locale = "en"): string => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  if (definition.mode === "always") return messages.alwaysOn;
  const activeDays = new Set(definition.weeklyWindows.map((window) => window.weekday)).size;
  const range = definition.activeRanges[0];
  const rangeLabel = range
    ? `${range.from} ${messages.until.toLocaleLowerCase(locale)} ${range.to ?? messages.openEnded}`
    : messages.noDateLimit;
  return messages.scheduleSummary({ range: rangeLabel, days: activeDays, timeZone: definition.timeZone });
};
