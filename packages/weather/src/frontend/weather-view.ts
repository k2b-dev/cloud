import type { GeoProvenance } from "@k2b/cloud/contracts";
import { weatherUiService } from "@k2b/cloud/services/weather/ui";
import type { WeatherDataPayload } from "../contracts";
import { type WeatherMessages, weatherConditionLabel } from "../messages";

/** A saved location in the sidebar: its symbol and temperature come from its current weather, if any. */
export type WeatherPlace = { id: string; name: string; state: string | null; icon: string; temperature: string | null };

export type WeatherHour = { time: string; icon: string; condition: string; temperature: string; rain: string };
export type WeatherDay = { day: string; icon: string; condition: string; range: string; rain: string; sunshine: string };

/** The weather of the open location, every value already in the reader's words and numbers. */
export type WeatherNow = {
  icon: string;
  condition: string;
  temperature: string;
  station: string;
  humidity: string;
  clouds: string;
  wind: string;
  rain: string;
  pressure: string;
  dewPoint: string;
  visibility: string;
  sunshine: string;
  hourly: WeatherHour[];
  daily: WeatherDay[];
};

export type WeatherOpen = { id: string; name: string; state: string | null; lat: number; lon: number; geoapify: boolean };

/** A place the geo search found. */
export type GeoResult = { name: string; lat: number; lon: number; country?: string; state?: string; provenance: GeoProvenance };

const TIME_ZONE = "Europe/Berlin";

const calendarDate = (value: Date): string => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    value,
  );
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const nextDate = (date: string): string => {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
};

/** Formats numbers, dates and words of one request; the server hands the screen only text. */
export const weatherFormat = (locale: string, t: WeatherMessages, now: Date) => {
  const number = (value: number, digits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  const percent = (value: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(value / 100);
  const degrees = (value: number) => `${number(value, 1)}°`;
  const missing = "–";
  const today = calendarDate(now);
  const day = (date: string) =>
    date === today
      ? t.today
      : date === nextDate(today)
        ? t.tomorrow
        : new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
  const hour = (timestamp: string, first: boolean) =>
    first
      ? t.now
      : new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: TIME_ZONE }).format(new Date(timestamp));

  const place = (
    location: { id: string; name: string; state: string | null },
    data: WeatherDataPayload | null | undefined,
  ): WeatherPlace => ({
    id: location.id,
    name: location.name,
    state: location.state,
    icon: data ? weatherUiService.getTablerIcon(data.current.icon) : "map-pin",
    temperature: data ? degrees(data.current.temperature) : null,
  });

  const weather = (data: WeatherDataPayload): WeatherNow => {
    const { current } = data;
    return {
      icon: weatherUiService.getTablerIcon(current.icon),
      condition: weatherConditionLabel(current.icon, t),
      temperature: degrees(current.temperature),
      station: current.stationName,
      humidity: current.humidity == null ? missing : percent(current.humidity),
      clouds: percent(current.cloudCover),
      wind: `${number(current.windSpeed)} km/h`,
      rain: `${number(current.precipitation, 1)} mm`,
      pressure: current.pressure == null ? missing : `${number(current.pressure)} hPa`,
      dewPoint: current.dewPoint == null ? missing : degrees(current.dewPoint),
      visibility: current.visibility == null ? missing : `${number(current.visibility / 1000, 1)} km`,
      sunshine: current.sunshine == null ? missing : `${number(current.sunshine)} min`,
      hourly: data.hourly.map((entry, index) => ({
        time: hour(entry.timestamp, index === 0),
        icon: weatherUiService.getTablerIcon(entry.icon),
        condition: weatherConditionLabel(entry.icon, t),
        temperature: degrees(entry.temperature),
        rain: entry.precipitationProbability ? percent(entry.precipitationProbability) : missing,
      })),
      daily: data.daily.map((entry) => ({
        day: day(entry.date),
        icon: weatherUiService.getTablerIcon(entry.icon),
        condition: weatherConditionLabel(entry.icon, t),
        range: `${degrees(entry.tempMin)} / ${degrees(entry.tempMax)}`,
        rain: entry.precipitationProbability ? percent(entry.precipitationProbability) : missing,
        sunshine: `${number(entry.sunshine / 60, 1)} h`,
      })),
    };
  };

  return { place, weather };
};
