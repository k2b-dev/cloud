import type { WidgetBlock, WidgetListItem, WidgetResponse } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale, getUserBackedActor } from "@valentinkolb/cloud/server";
import { logger, weatherService } from "@valentinkolb/cloud/services";
import { Hono } from "hono";
import { type WeatherMessages, weatherConditionLabel, weatherMessages } from "../messages";

const log = logger("weather");

/**
 * Weather widget — every saved location of the current user, fresh forecast
 * each. Capped at 7 to keep the widget body within fixed height.
 *
 * Composition:
 *   - 0 locations → hero with "Add a location" hint
 *   - 1 location  → hero (big icon + temp + city) + pills (wind/humid/hPa)
 *   - 2-7         → list (one row per location with weather icon, temp, condition)
 *
 * Status: 200 always (with appropriate empty-state body), 403 when not signed in.
 */
const LOCATION_LIMIT = 7;

const ICON_MAP: Record<string, string> = {
  "clear-day": "ti ti-sun",
  "clear-night": "ti ti-moon",
  "partly-cloudy-day": "ti ti-cloud-filled",
  "partly-cloudy-night": "ti ti-cloud-filled",
  cloudy: "ti ti-cloud",
  fog: "ti ti-mist",
  rain: "ti ti-cloud-rain",
  sleet: "ti ti-cloud-rain",
  snow: "ti ti-snowflake",
  wind: "ti ti-wind",
  thunderstorm: "ti ti-bolt",
  hail: "ti ti-cloud-rain",
};

const iconFor = (icon: string, t: WeatherMessages) => ({
  ti: ICON_MAP[icon] ?? "ti ti-cloud",
  verbal: weatherConditionLabel(icon, t),
});

export const weatherWidgetUnavailableBody = (locale: string, message?: string): WidgetResponse => {
  const { t } = weatherMessages.resolve([locale]);
  return {
    title: t.appName,
    icon: "ti ti-cloud",
    href: "/app/weather",
    blocks: [
      {
        kind: "status",
        tone: "error",
        title: t.widgetUnavailable,
        message: message ?? t.widgetLocationsFailed,
        icon: "ti ti-alert-circle",
        grow: true,
      },
    ],
  };
};

export const weatherWidgetEmptyBody = (locale: string): WidgetResponse => {
  const { t } = weatherMessages.resolve([locale]);
  return {
    title: t.appName,
    icon: "ti ti-cloud",
    href: "/app/weather",
    blocks: [
      {
        kind: "hero",
        icon: "ti ti-map-pin-plus",
        tone: "blue",
        title: t.widgetNoLocations,
        subtitle: t.widgetNoLocationsHint,
      },
    ],
  };
};

const app = new Hono<AuthContext>().use(auth.requireRole("*")).get("/current", async (c) => {
  const { locale, t } = weatherMessages.resolve([getLocale(c)]);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const user = getUserBackedActor(c);
  if (!user) return c.body(null, 403);

  let locations: Awaited<ReturnType<typeof weatherService.location.saved.list>>["items"];
  try {
    ({ items: locations } = await weatherService.location.saved.list({ userId: user.id }));
  } catch (error) {
    log.warn("Weather widget locations failed", {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(weatherWidgetUnavailableBody(locale));
  }

  if (locations.length === 0) {
    return c.json(weatherWidgetEmptyBody(locale));
  }

  const capped = locations.slice(0, LOCATION_LIMIT);
  const forecasts = await Promise.all(
    capped.map(async (loc) => {
      try {
        return {
          loc,
          data: await weatherService.forecast.current.get({
            lat: String(loc.lat),
            lon: String(loc.lon),
          }),
        };
      } catch (error) {
        log.warn("Weather widget forecast failed", {
          locationId: loc.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return { loc, data: null };
      }
    }),
  );

  // Single-location → hero + pills (rich single-cell view).
  if (forecasts.length === 1) {
    const entry = forecasts[0]!;
    if (!entry.data) {
      const body: WidgetResponse = {
        title: t.appName,
        icon: "ti ti-cloud",
        href: "/app/weather",
        blocks: [
          {
            kind: "hero",
            icon: "ti ti-cloud-off",
            title: t.widgetForecastUnavailable,
            subtitle: t.widgetProviderFailed({ name: entry.loc.name }),
          },
        ],
      };
      return c.json(body);
    }
    const ic = iconFor(entry.data.icon, t);
    const blocks: WidgetBlock[] = [
      {
        kind: "hero",
        icon: ic.ti,
        tone: "blue",
        title: `${number.format(entry.data.temperature)}°C · ${ic.verbal}`,
        subtitle: entry.loc.name,
      },
      {
        kind: "pills",
        pills: [
          { label: t.widgetWind, value: `${number.format(entry.data.windSpeed)} km/h` },
          ...(entry.data.humidity !== null ? [{ label: t.widgetHumidity, value: percent.format(entry.data.humidity / 100) } as const] : []),
          ...(entry.data.pressure !== null ? [{ label: "hPa", value: number.format(entry.data.pressure) } as const] : []),
        ],
      },
    ];
    const body: WidgetResponse = {
      title: t.appName,
      icon: ic.ti,
      href: "/app/weather",
      blocks,
    };
    return c.json(body);
  }

  // Multi-location → one row per saved place, list grows to fill the body.
  const items: WidgetListItem[] = forecasts.map(({ loc, data }) => {
    if (!data) {
      return {
        icon: "ti ti-cloud-off",
        iconTone: "zinc",
        label: loc.name,
        sub: t.widgetNoData,
      };
    }
    const ic = iconFor(data.icon, t);
    return {
      icon: ic.ti,
      iconTone: "blue",
      label: loc.name,
      sub: ic.verbal,
      meta: `${number.format(data.temperature)}°C`,
    };
  });

  const body: WidgetResponse = {
    title: t.appName,
    icon: "ti ti-cloud",
    href: "/app/weather",
    meta: locations.length > LOCATION_LIMIT ? t.widgetCount({ shown: LOCATION_LIMIT, total: locations.length }) : undefined,
    blocks: [{ kind: "list", items, grow: true }],
  };
  return c.json(body);
});

export default app;
