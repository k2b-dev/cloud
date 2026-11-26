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
import { useLocale } from "@k2b/ui";
import { Button, DatePicker, Dialog, Empty, Field, Menu, Row, Section, Select, Text, useToast } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import { useAccountMessages } from "./AccountWorkspace";
import type { AccountMessages } from "./messages";

const HOUR_MS = 60 * 60_000;
/** How long to wait before asking again when a refresh failed or the server still reports a passed change. */
const RETRY_MS = 30_000;
/** Do not disturb as a thing: the same mark for the pause and each quiet period. */
const QUIET_COLOR = "#6366f1";
const DEFAULT_PERIOD: NotificationQuietPeriod = { days: [1, 2, 3, 4, 5, 6, 7], start: "22:00", end: "07:00" };
const HALF_HOURS = Array.from({ length: 48 }, (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`);
// 1 January 2024 was a Monday, so day n of that week is ISO weekday n.
const weekdayOptions = (locale: string) =>
  [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    value: String(day),
    label: new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2024, 0, day)),
  }));
const timeOptions = (current: string) => (HALF_HOURS.includes(current) ? HALF_HOURS : [...HALF_HOURS, current].sort());

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

/**
 * Notifications › Do not disturb: a pause until a chosen time and recurring quiet hours. The state follows the clock
 * and refreshes itself when it changes on its own; each save replaces the whole snapshot, one at a time.
 */
export default function QuietTimeSection(props: { initial: NotificationQuietSettings; dateConfig: DateContext }) {
  const locale = useLocale();
  const t = useAccountMessages();
  const toast = useToast();
  const context = () => ({ ...props.dateConfig, locale: locale() });
  const [settings, setSettings] = createSignal(props.initial);
  // One write at a time: each response replaces the whole snapshot, so an earlier one must not land last.
  const [saving, setSaving] = createSignal<"pause" | "hours" | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const hours = () => settings().quietHours;
  const timeZones = createMemo(() => {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes(hours().timeZone) ? zones : [hours().timeZone, ...zones];
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
      toast(kind === "pause" ? t().pauseSaveFailed : t().quietHoursSaveFailed, { status: "bad" });
      return false;
    } finally {
      setSaving(null);
    }
  };

  /** Why a pause cannot end at this instant, or null when it can. */
  const pauseProblem = (until: string): string | null => {
    if (Date.parse(until) <= Date.now()) return t().pauseInPast;
    if (Date.parse(until) > Date.now() + NOTIFICATION_DO_NOT_DISTURB_MAX_DAYS * 24 * HOUR_MS) return t().pauseTooFar;
    return null;
  };
  const pause = async (until: string | null): Promise<boolean> => {
    const problem = until ? pauseProblem(until) : null;
    if (problem) {
      toast(problem, { status: "bad" });
      return false;
    }
    const saved = await save("pause", { doNotDisturbUntil: until });
    if (saved) toast(until ? t().pauseSaved : t().pauseResumed, { status: "ok" });
    return saved;
  };

  // ── A pause until a chosen day and time, in the zone of the person ──
  const zone = () => props.dateConfig.timeZone ?? "UTC";
  const [customOpen, setCustomOpen] = createSignal(false);
  const [customError, setCustomError] = createSignal<string | undefined>();
  const dayIn = (instant: number) => dates.instantToZonedInput(new Date(instant), zone()).slice(0, 10);
  const customValue = () => {
    const until = pausedUntil();
    return until ? dates.instantToZonedInput(new Date(until), zone()).slice(0, 16) : undefined;
  };
  const openCustom = () => {
    setCustomError(undefined);
    setCustomOpen(true);
  };
  const pickCustom = async (wallTime: string) => {
    const until = dates.zonedDateTimeToInstant(wallTime, zone(), { disambiguation: "compatible" });
    const problem = pauseProblem(until);
    if (problem) return setCustomError(problem);
    if (await pause(until)) setCustomOpen(false);
  };

  /** Saves the quiet hours as a whole; the shown hours are always the saved ones. */
  const saveHours = async (next: NotificationQuietHours): Promise<boolean> => {
    const saved = await save("hours", { quietHours: next });
    if (saved) toast(t().quietHoursSaved, { status: "ok" });
    return saved;
  };

  // ── One quiet period in a dialog: a new one (index null) or a saved one ──
  const [editing, setEditing] = createSignal<{ index: number | null; period: NotificationQuietPeriod } | null>(null);
  const change = (update: Partial<NotificationQuietPeriod>) =>
    setEditing((current) => (current ? { ...current, period: { ...current.period, ...update } } : current));
  const savePeriod = async () => {
    const current = editing();
    if (!current || current.period.days.length === 0) return;
    const periods = hours().periods;
    const next =
      current.index === null
        ? [...periods, current.period]
        : periods.map((period, position) => (position === current.index ? current.period : period));
    if (await saveHours({ ...hours(), periods: next })) setEditing(null);
  };

  const days = (period: NotificationQuietPeriod) => {
    const names = weekdayOptions(locale());
    return period.days.length === 7 ? t().quietEveryDay : period.days.map((day) => names[day - 1]?.label ?? String(day)).join(", ");
  };
  const toggleDay = (day: number) => {
    const period = editing()?.period;
    if (!period) return;
    change({
      days: (period.days.includes(day) ? period.days.filter((value) => value !== day) : [...period.days, day]).sort(
        (left, right) => left - right,
      ),
    });
  };
  const pausedUntil = () => settings().doNotDisturbUntil;

  return (
    <>
      <Section
        icon="moon"
        title={t().quietTitle}
        actions={[
          {
            label: t().quietAddPeriod,
            icon: "plus",
            disabled: saving() !== null || hours().periods.length >= NOTIFICATION_QUIET_PERIOD_LIMIT,
            onClick: () => setEditing({ index: null, period: DEFAULT_PERIOD }),
          },
        ]}
      >
        <Row
          mark={{ icon: settings().state.active ? "moon" : "moon-off", color: QUIET_COLOR }}
          lines={[settings().state.active ? statusLabel(settings(), t(), now(), context()) : t().pauseNotPaused, t().quietDescription]}
          end={
            <Menu
              label={t().pauseUntil}
              disabled={saving() !== null}
              items={[
                ...presets().map((preset) => ({ label: preset.label, icon: "player-pause", onClick: () => void pause(preset.value) })),
                { label: t().customDate, icon: "calendar", onClick: openCustom },
                ...(pausedUntil()
                  ? ["separator" as const, { label: t().pauseResume, icon: "player-play", onClick: () => void pause(null) }]
                  : []),
              ]}
            >
              {pausedUntil() ? t().pauseChange : t().pauseTitle}
            </Menu>
          }
        />
        <Index each={hours().periods} fallback={<Empty icon="clock" text={t().quietNoPeriods} />}>
          {(period, index) => (
            <Row
              mark={{ icon: "clock", color: QUIET_COLOR }}
              lines={[t().quietPeriodTitle({ from: period().start, to: period().end }), days(period())]}
              end={
                <Menu
                  label={t().quietPeriodActions}
                  disabled={saving() !== null}
                  items={[
                    { label: t().change, icon: "pencil", onClick: () => setEditing({ index, period: period() }) },
                    {
                      label: t().quietRemovePeriod,
                      icon: "trash",
                      danger: true,
                      onClick: () => void saveHours({ ...hours(), periods: hours().periods.filter((_, position) => position !== index) }),
                    },
                  ]}
                />
              }
            />
          )}
        </Index>
        <Row
          lines={[t().quietTimeZone, t().quietHoursDescription]}
          end={
            <Select
              label={t().quietTimeZone}
              options={timeZones()}
              value={hours().timeZone}
              onChange={(timeZone) => timeZone && timeZone !== hours().timeZone && void saveHours({ ...hours(), timeZone })}
            />
          }
        />
      </Section>
      <Dialog
        title={t().pauseCustomTitle}
        open={customOpen()}
        onOpenChange={(open) => saving() === null && setCustomOpen(open)}
        foot={
          <Button disabled={saving() !== null} onClick={() => setCustomOpen(false)}>
            {t().cancel}
          </Button>
        }
      >
        <Text muted>{t().pauseCustomHint}</Text>
        <DatePicker
          time
          value={customValue()}
          defaultTime="08:00"
          min={dayIn(now())}
          max={dayIn(now() + NOTIFICATION_DO_NOT_DISTURB_MAX_DAYS * 24 * HOUR_MS)}
          timeZone={zone()}
          label={t().pauseUntil}
          error={customError()}
          onPick={(value) => void pickCustom(value)}
          autoFocus
        />
      </Dialog>
      <Dialog
        title={editing()?.index === null ? t().quietAddPeriod : t().quietEditPeriod}
        open={editing() !== null}
        onOpenChange={(open) => !open && saving() === null && setEditing(null)}
        foot={
          <>
            <Button disabled={saving() !== null} onClick={() => setEditing(null)}>
              {t().cancel}
            </Button>
            <Button
              variant="primary"
              busy={saving() === "hours"}
              disabled={(editing()?.period.days.length ?? 0) === 0}
              onClick={() => void savePeriod()}
            >
              {t().save}
            </Button>
          </>
        }
      >
        <Show when={editing()}>
          {(current) => (
            <Field.Row>
              <Field name="quietDays" label={t().quietDays} error={current().period.days.length === 0 ? t().quietDaysRequired : undefined}>
                <Menu
                  label={t().quietDays}
                  items={weekdayOptions(locale()).map((option) => ({
                    label: option.label,
                    checked: current().period.days.includes(Number(option.value)),
                    onClick: () => toggleDay(Number(option.value)),
                  }))}
                >
                  {current().period.days.length > 0 ? days(current().period) : t().quietDaysRequired}
                </Menu>
              </Field>
              <Field name="quietFrom" label={t().quietFrom}>
                <Select
                  options={timeOptions(current().period.start)}
                  value={current().period.start}
                  onChange={(start) => start && change({ start })}
                />
              </Field>
              <Field name="quietTo" label={t().quietTo}>
                <Select
                  options={timeOptions(current().period.end)}
                  value={current().period.end}
                  onChange={(end) => end && change({ end })}
                />
              </Field>
            </Field.Row>
          )}
        </Show>
      </Dialog>
    </>
  );
}
