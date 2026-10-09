import { apiClient } from "@k2b/cloud/clients/core";
import {
  NOTIFICATION_DO_NOT_DISTURB_MAX_DAYS,
  NOTIFICATION_QUIET_PERIOD_LIMIT,
  type NotificationQuietHours,
  type NotificationQuietPeriod,
  type NotificationQuietSettings,
  type UpdateNotificationQuietSettings,
} from "@k2b/cloud/contracts";
import { type DateContext, dates } from "@k2b/stdlib";
import {
  Button,
  DateTimePicker,
  IconButton,
  MultiSelectInput,
  Select,
  SettingsGroup,
  SettingsSection,
  StatusBadge,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { type AccountMessages, accountMessages } from "./messages";

const HOUR_MS = 60 * 60_000;
/** How long to wait before asking again when a refresh failed or the server still reports a passed change. */
const RETRY_MS = 30_000;
const DEFAULT_PERIOD: NotificationQuietPeriod = { days: [1, 2, 3, 4, 5, 6, 7], start: "22:00", end: "07:00" };
const HALF_HOURS = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`);
// 1 January 2024 was a Monday, so day n of that week is ISO weekday n.
const weekdayOptions = (locale: string) =>
  [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    value: String(day),
    label: new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2024, 0, day)),
  }));
const timeOptions = (current: string) => (HALF_HOURS.includes(current) ? HALF_HOURS : [...HALF_HOURS, current].sort());
const sameHours = (left: NotificationQuietHours, right: NotificationQuietHours) => JSON.stringify(left) === JSON.stringify(right);

/** "Paused until 08:00" today, with the date when the end is on another day. */
const formatUntil = (until: string, now: number, context: DateContext): string =>
  dates.isSameDay(new Date(until), new Date(now), context) ? dates.formatTime(until, context) : dates.formatDateTime(until, context);

/**
 * How long until the state changes on its own: a pause ends (also inside quiet hours, where `until` lies later),
 * the quiet time ends, or the next quiet hours start. Null when nothing changes within the next week.
 */
const quietRefreshDelay = (settings: NotificationQuietSettings, now: number): number | null => {
  const { doNotDisturbUntil, state } = settings;
  const changes = [doNotDisturbUntil, state.until, state.nextStart].filter((instant) => instant !== null).map(Date.parse);
  if (changes.length === 0) return null;
  const wait = Math.min(...changes) - now;
  // A change the server still reports but this device's clock has passed means the clocks differ: ask again a
  // little later instead of in a loop. Long waits check in hourly instead of relying on a timer that runs for days.
  return wait > 0 ? Math.min(wait + 1_000, HOUR_MS) : RETRY_MS;
};

const statusLabel = (settings: NotificationQuietSettings, t: AccountMessages, now: number, context: DateContext): string => {
  const { state } = settings;
  if (!state.active) return t.quietOff;
  const until = state.until ? formatUntil(state.until, now, context) : null;
  if (state.reason === "doNotDisturb") return until ? t.quietPausedUntil({ time: until }) : t.quietPaused;
  return until ? t.quietHoursUntil({ time: until }) : t.quietHoursNow;
};

export default function QuietTimeSettings(props: { initial: NotificationQuietSettings; dateConfig: DateContext }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const context = () => ({ ...props.dateConfig, locale: locale() });
  const [settings, setSettings] = createSignal(props.initial);
  const [draft, setDraft] = createSignal<NotificationQuietHours>(props.initial.quietHours);
  // One write at a time: each response replaces the whole snapshot, so an earlier one must not land last.
  const [saving, setSaving] = createSignal<"pause" | "hours" | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const dirty = () => !sameHours(draft(), settings().quietHours);
  const invalid = () => draft().periods.some((period) => period.days.length === 0);
  const timeZones = createMemo(() => {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes(draft().timeZone) ? zones : [draft().timeZone, ...zones];
  });

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (delay: number | null) => {
    clearTimeout(refreshTimer);
    if (delay !== null) refreshTimer = setTimeout(() => void refresh(), delay);
  };
  const refresh = async () => {
    try {
      const response = await apiClient.me.notifications.quiet.$get();
      if (!response.ok) throw new Error();
      setSettings(await response.json());
    } catch {
      // Offline or the server is unavailable: keep the last state and try again.
      scheduleRefresh(RETRY_MS);
    }
  };

  onMount(() => {
    // Presets are relative to now, and the status follows the clock: refresh both while the page stays open.
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(tick));
  });
  // Reload the state when it changes on its own.
  createEffect(() => scheduleRefresh(quietRefreshDelay(settings(), Date.now())));
  onCleanup(() => clearTimeout(refreshTimer));

  const presets = () => {
    const at = now();
    const timeZone = props.dateConfig.timeZone ?? "UTC";
    const [today = ""] = dates.instantToZonedInput(new Date(at), timeZone).split("T");
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const morning = dates.zonedDateTimeToInstant(`${tomorrow.toISOString().slice(0, 10)}T08:00`, timeZone, {
      disambiguation: "compatible",
    });
    const minute = (instant: number) => new Date(Math.ceil(instant / 60_000) * 60_000).toISOString();
    return [
      { label: t().pauseOneHour, value: minute(at + HOUR_MS) },
      { label: t().pauseTomorrowMorning, value: morning },
      { label: t().pauseOneWeek, value: minute(at + 7 * 24 * HOUR_MS) },
    ];
  };

  const save = async (kind: "pause" | "hours", update: UpdateNotificationQuietSettings): Promise<boolean> => {
    setSaving(kind);
    try {
      const response = await apiClient.me.notifications.quiet.$patch({ json: update });
      if (!response.ok) throw new Error();
      const next = await response.json();
      setSettings(next);
      return true;
    } catch {
      toast.error(kind === "pause" ? t().pauseSaveFailed : t().quietHoursSaveFailed);
      return false;
    } finally {
      setSaving(null);
    }
  };

  const pause = async (until: string | null) => {
    if (until && Date.parse(until) <= Date.now()) {
      toast.error(t().pauseInPast);
      return;
    }
    if (until && Date.parse(until) > Date.now() + NOTIFICATION_DO_NOT_DISTURB_MAX_DAYS * 24 * HOUR_MS) {
      toast.error(t().pauseTooFar);
      return;
    }
    if (await save("pause", { doNotDisturbUntil: until })) toast.success(until ? t().pauseSaved : t().pauseResumed);
  };

  const saveHours = async () => {
    const hours = draft();
    if (await save("hours", { quietHours: hours })) {
      // Take the saved form unless the periods changed while saving; those edits stay as unsaved changes.
      if (sameHours(draft(), hours)) setDraft(settings().quietHours);
      toast.success(t().quietHoursSaved);
    }
  };

  const updatePeriod = (index: number, change: Partial<NotificationQuietPeriod>) =>
    setDraft((current) => ({
      ...current,
      periods: current.periods.map((period, position) => (position === index ? { ...period, ...change } : period)),
    }));

  return (
    <SettingsSection
      title={t().quietTitle}
      subtitle={
        <>
          {t().quietDescription}
          {/* On a line of its own below the description: a longer status never rewraps the text or moves the fields. */}
          <span class="mt-2 flex">
            <StatusBadge
              tone={settings().state.active ? "info" : "neutral"}
              icon={settings().state.active ? "ti ti-moon" : null}
              label={statusLabel(settings(), t(), now(), context())}
            />
          </span>
        </>
      }
      icon="ti ti-moon"
    >
      <SettingsGroup title={t().pauseTitle} description={t().pauseDescription}>
        <DateTimePicker
          class="sm:max-w-sm"
          label={t().pauseUntil}
          placeholder={t().pauseNotPaused}
          value={() => settings().doNotDisturbUntil}
          presets={presets()}
          dateConfig={context()}
          clearable
          disabled={saving() !== null}
          onValueChange={(value) => void pause(value)}
        />
      </SettingsGroup>

      <SettingsGroup title={t().quietHoursTitle} description={t().quietHoursDescription}>
        <SettingsGroup.Action>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={saving() !== null || !dirty() || invalid()}
            loading={saving() === "hours"}
            loadingLabel={t().save}
            onClick={() => void saveHours()}
          >
            {t().save}
          </Button>
        </SettingsGroup.Action>
        <div class="flex flex-col gap-4">
          <Show when={draft().periods.length > 0} fallback={<p class="text-sm text-dimmed">{t().quietNoPeriods}</p>}>
            {/* Rows are keyed by position, so editing a period keeps its open controls. The times and the remove
                button share a cell of their own, so an error below the days moves nothing beside them. */}
            <Index each={draft().periods}>
              {(period, index) => (
                <div class="grid items-start gap-3 sm:grid-cols-2">
                  <MultiSelectInput
                    label={t().quietDays}
                    options={weekdayOptions(locale())}
                    value={() => period().days.map(String)}
                    error={period().days.length === 0 ? t().quietDaysRequired : undefined}
                    onValueChange={(days) => updatePeriod(index, { days: days.map(Number).sort((left, right) => left - right) })}
                  />
                  <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3">
                    <Select
                      label={t().quietFrom}
                      options={timeOptions(period().start)}
                      value={() => period().start}
                      onValueChange={(start) => start && updatePeriod(index, { start })}
                    />
                    <Select
                      label={t().quietTo}
                      options={timeOptions(period().end)}
                      value={() => period().end}
                      onValueChange={(end) => end && updatePeriod(index, { end })}
                    />
                    <IconButton
                      label={t().quietRemovePeriod}
                      onClick={() =>
                        setDraft((current) => ({ ...current, periods: current.periods.filter((_, position) => position !== index) }))
                      }
                    >
                      <i class="ti ti-trash" aria-hidden="true" />
                    </IconButton>
                  </div>
                </div>
              )}
            </Index>
          </Show>
          <div class="flex flex-wrap items-end justify-between gap-3">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={draft().periods.length >= NOTIFICATION_QUIET_PERIOD_LIMIT}
              onClick={() => setDraft((current) => ({ ...current, periods: [...current.periods, DEFAULT_PERIOD] }))}
            >
              <i class="ti ti-plus" aria-hidden="true" />
              {t().quietAddPeriod}
            </Button>
            <Select
              class="w-full sm:w-72"
              label={t().quietTimeZone}
              searchable
              options={timeZones()}
              value={() => draft().timeZone}
              onValueChange={(timeZone) => timeZone && setDraft((current) => ({ ...current, timeZone }))}
            />
          </div>
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
