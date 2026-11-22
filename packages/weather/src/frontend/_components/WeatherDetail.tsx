import type { GeoProvenance } from "@k2b/cloud/contracts";
import type { WeatherData } from "@k2b/cloud/services";
import { weatherUiService } from "@k2b/cloud/services/weather/ui";
import { Section, useLocale } from "@k2b/ui";
import { weatherMessages } from "../../messages";
import DailyForecast from "./DailyForecast";
import HourlyForecast from "./HourlyForecast";
import RadarCard from "./RadarCard";

export type WeatherLocation = {
  id: string;
  name: string;
  state: string | null;
  lat: number;
  lon: number;
  provenance?: GeoProvenance | null;
};

/* The measurement's own color tints its symbol: sun amber, dew blue, the rest neutral ink. */
const CONDITION_ICON_CLASSES = {
  amber: "text-amber-600 dark:text-amber-300",
  blue: "text-blue-600 dark:text-blue-300",
  zinc: "text-dimmed",
};

function CurrentConditionStat(props: { label: string; value: string; icon: string; tone: keyof typeof CONDITION_ICON_CLASSES }) {
  return (
    <div class="flex min-w-0 items-start gap-2">
      <i class={`${props.icon} mt-0.5 text-base ${CONDITION_ICON_CLASSES[props.tone]}`} aria-hidden="true" />
      <div class="flex min-w-0 flex-col">
        <span class="truncate text-xs text-dimmed">{props.label}</span>
        <span class="truncate text-sm font-semibold tabular-nums text-primary">{props.value}</span>
      </div>
    </div>
  );
}

/**
 * The forecast of one saved place as flat topics of the main column: the current weather on top, then hourly, the
 * week, the measurements, and the radar, each separated by one hairline that the column draws (K2, K9).
 */
export default function WeatherDetail(props: { location: WeatherLocation; data: WeatherData }) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const number = (value: number, maximumFractionDigits = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits }).format(value);
  const percent = (value: number) => new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format(value / 100);
  const location = () => props.location;
  const current = () => props.data.current;

  return (
    <article class="weather-detail k2b-divided" aria-label={t().weatherFor({ name: location().name })}>
      <section class="weather-now" aria-label={t().currentWeather}>
        <h1
          class="max-w-full truncate text-lg font-semibold text-primary"
          style={`view-transition-name: weather-location-${location().id}`}
        >
          {location().name}
        </h1>
        <div class="flex items-center gap-3">
          <i
            class={`ti ti-${weatherUiService.getTablerIcon(current().icon)} text-5xl ${weatherUiService.getTempColorClass(current().temperature)}`}
            aria-hidden="true"
            style="view-transition-name: weather-icon"
          />
          <span
            class={`text-5xl font-light tabular-nums ${weatherUiService.getTempColorClass(current().temperature)}`}
            title={`${t().temperature} ${number(current().temperature, 1)}°`}
            style="view-transition-name: weather-temp"
          >
            {number(current().temperature, 1)}°
          </span>
        </div>
        <dl class="weather-now__facts">
          <div>
            <dt>{t().humidity}</dt>
            <dd>{current().humidity == null ? "-" : percent(current().humidity ?? 0)}</dd>
          </div>
          <div>
            <dt>{t().clouds}</dt>
            <dd>{percent(current().cloudCover)}</dd>
          </div>
          <div>
            <dt>{t().wind}</dt>
            <dd>{number(current().windSpeed)} km/h</dd>
          </div>
          <div>
            <dt>{t().rain}</dt>
            <dd>{number(current().precipitation, 1)} mm</dd>
          </div>
        </dl>
        {(location().state || location().provenance) && (
          <p class="max-w-full truncate text-xs text-dimmed">
            {location().state}
            {location().state && location().provenance ? " · " : null}
            {location().provenance && (
              <>
                <a href="https://www.geoapify.com/" class="underline" target="_blank" rel="noopener noreferrer">
                  Geoapify
                </a>
                {" · "}
                <a href="https://www.openstreetmap.org/copyright" class="underline" target="_blank" rel="noopener noreferrer">
                  OpenStreetMap
                </a>
              </>
            )}
          </p>
        )}
      </section>

      {props.data.hourly.length > 0 && (
        <div>
          <Section size="md" icon="ti ti-clock-hour-4" title={t().hourly}>
            <HourlyForecast hourly={props.data.hourly} scrollPreserveKey={`weather-hourly-${location().id}`} />
          </Section>
        </div>
      )}

      <div class="weather-columns">
        <div class="k2b-divided">
          {props.data.daily.length > 0 && (
            <div>
              <Section size="md" icon="ti ti-calendar-week" title={t().sevenDayForecast} class="weather-week">
                <DailyForecast daily={props.data.daily} />
              </Section>
            </div>
          )}

          <div>
            <Section size="md" icon="ti ti-gauge" title={t().currentConditions}>
              <div class="grid grid-cols-2 gap-x-6 gap-y-4">
                <CurrentConditionStat
                  label={t().pressure}
                  value={current().pressure != null ? `${number(current().pressure ?? 0)} hPa` : "-"}
                  icon="ti ti-gauge"
                  tone="zinc"
                />
                <CurrentConditionStat
                  label={t().dewPoint}
                  value={current().dewPoint != null ? `${number(current().dewPoint ?? 0, 1)}°` : "-"}
                  icon="ti ti-droplet"
                  tone="blue"
                />
                <CurrentConditionStat
                  label={t().visibility}
                  value={current().visibility != null ? `${number((current().visibility ?? 0) / 1000, 1)} km` : "-"}
                  icon="ti ti-eye"
                  tone="zinc"
                />
                <CurrentConditionStat
                  label={t().sunshine}
                  value={current().sunshine != null ? `${number(current().sunshine ?? 0)} min` : "-"}
                  icon="ti ti-sun"
                  tone="amber"
                />
              </div>
            </Section>
          </div>
        </div>

        <div>
          <Section size="md" icon="ti ti-radar" title={t().rainRadar}>
            <RadarCard showLegend />
          </Section>
        </div>
      </div>
    </article>
  );
}
