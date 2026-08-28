import { useLocale } from "@k2b/ui";
import { weatherUiService } from "@valentinkolb/cloud/services/weather/ui";
import type { HourlyForecastPayload } from "../../contracts";
import { weatherMessages } from "../../messages";

const formatHour = (timestamp: string, isFirst: boolean, locale: string, now: string): string => {
  if (isFirst) return now;
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(new Date(timestamp));
};

type HourlyForecastProps = {
  hourly: HourlyForecastPayload[];
  /** Number of hours to show (default: all). */
  limit?: number;
  /** Size variant. */
  size?: "sm" | "md" | "lg";
  /** Show "Now" for first item (default: true). */
  showNow?: boolean;
  /** Stable key for enhanced navigation scroll restoration. */
  scrollPreserveKey?: string;
};

const sizeClasses = {
  sm: {
    container: "gap-4",
    time: "text-[10px]",
    icon: "text-sm",
    temp: "text-xs",
    rain: "text-[10px]",
    rainIcon: "text-[8px]",
    minWidth: "min-w-10",
  },
  md: {
    container: "gap-6",
    time: "text-xs",
    icon: "text-base",
    temp: "text-sm",
    rain: "text-[10px]",
    rainIcon: "text-[8px]",
    minWidth: "min-w-14",
  },
  lg: {
    container: "gap-10",
    time: "text-base",
    icon: "text-2xl",
    temp: "text-lg",
    rain: "text-sm",
    rainIcon: "text-xs",
    minWidth: "min-w-20",
  },
};

export default function HourlyForecast({ hourly, limit, size = "md", showNow = true, scrollPreserveKey }: HourlyForecastProps) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const number = (value: number, maximumFractionDigits = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits }).format(value);
  const percent = (value: number) => new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(value / 100);
  const items = limit ? hourly.slice(0, limit) : hourly;
  const s = sizeClasses[size];

  if (items.length === 0) return null;

  return (
    <div
      class={`flex ${s.container} overflow-x-auto pb-1`}
      role="list"
      aria-label={t().hourlyTemperatureForecast}
      data-scroll-preserve={scrollPreserveKey}
    >
      {items.map((h, idx) => (
        <div class={`flex flex-col items-center gap-1 ${s.minWidth} flex-1`} role="listitem">
          <span class={`${s.time} ${idx === 0 && showNow ? "text-secondary font-medium" : "text-dimmed"}`}>
            {formatHour(h.timestamp, idx === 0 && showNow, locale(), t().now)}
          </span>
          <div class="flex items-center gap-1">
            <i
              class={`ti ti-${weatherUiService.getTablerIcon(h.icon)} ${s.icon} ${weatherUiService.getTempColorClass(h.temperature)}`}
              aria-hidden="true"
            />
            <span class={`${s.temp} font-medium ${weatherUiService.getTempColorClass(h.temperature)}`}>{number(h.temperature, 1)}°</span>
          </div>
          {h.precipitationProbability != null && h.precipitationProbability > 0 ? (
            <span class={`${s.rain} text-blue-500`}>
              <i class={`ti ti-droplet ${s.rainIcon}`} aria-hidden="true" /> {percent(h.precipitationProbability)}
            </span>
          ) : (
            <span class={`${s.rain} text-transparent`} aria-hidden="true">
              -
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
