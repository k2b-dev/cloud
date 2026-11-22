import { weatherUiService } from "@k2b/cloud/services/weather/ui";
import { useLocale } from "@k2b/ui";
import type { DailyForecastPayload } from "../../contracts";
import { weatherMessages } from "../../messages";

const calendarDate = (value: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const nextCalendarDate = (date: string): string => {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
};

const formatDay = (
  dateStr: string,
  locale: string,
  referenceTime: string | undefined,
  todayLabel: string,
  tomorrowLabel: string,
): string => {
  const today = calendarDate(referenceTime ? new Date(referenceTime) : new Date(), "Europe/Berlin");

  if (dateStr === today) return todayLabel;
  if (dateStr === nextCalendarDate(today)) return tomorrowLabel;

  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${dateStr}T12:00:00Z`));
};

type DailyForecastProps = {
  daily: DailyForecastPayload[];
  /** Size variant */
  size?: "sm" | "md" | "lg";
  /** Show temperature bar visualization (default: true) */
  showBar?: boolean;
  /** Stable reference instant for Today/Tomorrow labels in hydrated displays. */
  referenceTime?: string;
};

const sizeClasses = {
  sm: {
    day: "text-xs",
    icon: "text-base",
    temp: "text-xs",
    rain: "text-[10px]",
    rainIcon: "text-[8px]",
    sun: "text-[10px]",
    sunIcon: "text-[8px]",
    columns: "[--weather-rain:3rem] [--weather-sun:2.75rem]",
    gap: "gap-2",
    py: "py-1.5",
  },
  md: {
    day: "text-sm",
    icon: "text-xl",
    temp: "text-sm",
    rain: "text-xs",
    rainIcon: "text-[10px]",
    sun: "text-xs",
    sunIcon: "text-[10px]",
    columns: "[--weather-rain:3.5rem] [--weather-sun:3rem]",
    gap: "gap-2.5",
    py: "py-2",
  },
  lg: {
    day: "text-lg",
    icon: "text-3xl",
    temp: "text-lg",
    rain: "text-base",
    rainIcon: "text-sm",
    sun: "text-base",
    sunIcon: "text-sm",
    columns: "[--weather-rain:5.5rem] [--weather-sun:4.5rem]",
    gap: "gap-3",
    py: "py-3",
  },
};

export default function DailyForecast({ daily, size = "md", showBar = true, referenceTime }: DailyForecastProps) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const number = (value: number, maximumFractionDigits = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits }).format(value);
  const percent = (value: number) => new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(value / 100);
  const s = sizeClasses[size];

  if (daily.length === 0) return null;

  // One row grid for every day: day, symbol, temperatures, then rain and sunshine as fixed columns, so the values of all
  // rows stand under each other and an empty value keeps its place. Under 25rem of list width the sunshine column
  // leaves whole; no number is ever cut (K7, K15).
  return (
    <div class={`@container flex min-w-0 flex-col gap-1 ${s.columns}`} role="list">
      {daily.map((d) => (
        <div
          class={`weather-day grid min-w-0 grid-cols-[minmax(4.75rem,6.5rem)_1.75rem_minmax(0,1fr)_var(--weather-rain)_var(--weather-sun)] items-center @max-[25rem]:grid-cols-[minmax(4.75rem,6.5rem)_1.75rem_minmax(0,1fr)_var(--weather-rain)] ${s.gap} ${s.py}`}
          role="listitem"
        >
          <span class={`${s.day} truncate font-medium`}>{formatDay(d.date, locale(), referenceTime, t().today, t().tomorrow)}</span>
          <i
            class={`ti ti-${weatherUiService.getTablerIcon(d.icon)} ${
              s.icon
            } ${weatherUiService.getAvgTempColorClass(d.tempMin, d.tempMax)}`}
            aria-hidden="true"
          />
          <div class="flex min-w-0 items-center gap-2">
            <span class={`${s.temp} min-w-[2.5em] shrink-0 text-right tabular-nums text-dimmed`}>{number(d.tempMin, 1)}°</span>
            {showBar && (
              <div
                class="h-1.5 min-w-4 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
                role="img"
                aria-label={t().temperatureRange({
                  min: `${number(d.tempMin, 1)}°`,
                  max: `${number(d.tempMax, 1)}°`,
                })}
              >
                <div
                  class="h-full bg-linear-to-r from-blue-400 via-emerald-400 to-amber-400 rounded-full"
                  style={`width: ${Math.min(100, Math.max(20, ((d.tempMax - d.tempMin) / 30) * 100))}%; margin-left: ${Math.max(
                    0,
                    ((d.tempMin + 10) / 50) * 100,
                  )}%`}
                />
              </div>
            )}
            <span class={`${s.temp} min-w-[2.5em] shrink-0 font-medium tabular-nums ${weatherUiService.getTempColorClass(d.tempMax)}`}>
              {number(d.tempMax, 1)}°
            </span>
          </div>
          <span class={`weather-day__rain ${s.rain} whitespace-nowrap text-right tabular-nums text-dimmed`}>
            {d.precipitationProbability != null && d.precipitationProbability > 0 && (
              <>
                <i class={`ti ti-droplet ${s.rainIcon} text-blue-500`} aria-hidden="true" /> {percent(d.precipitationProbability)}
              </>
            )}
          </span>
          <span class={`weather-day__sun ${s.sun} whitespace-nowrap text-right tabular-nums text-dimmed @max-[25rem]:hidden`}>
            {d.sunshine > 0 && (
              <>
                <i class={`ti ti-sun ${s.sunIcon} text-amber-500`} aria-hidden="true" /> {number(d.sunshine / 60)} h
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
