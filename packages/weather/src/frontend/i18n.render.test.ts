import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { WeatherDataPayload } from "../contracts";

const root = mkdtempSync(resolve(tmpdir(), "weather-i18n-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider } = await import("@k2b/ui");
const { DetailDisplayView, DisplayUnavailable } = await import("./display/DisplayViews");

const data: WeatherDataPayload = {
  current: {
    temperature: 12,
    icon: "rain",
    cloudCover: 75,
    windSpeed: 9,
    windGust: null,
    windDirection: 180,
    humidity: 83,
    precipitation: 1.5,
    pressure: 1_013,
    visibility: 10_500,
    dewPoint: 8.5,
    sunshine: 0,
    stationName: "Ulm",
    timestamp: "2026-08-28T10:00:00.000Z",
  },
  hourly: [],
  daily: [
    {
      date: "2026-08-28",
      icon: "rain",
      tempMin: 8,
      tempMax: 14,
      precipitation: 2,
      precipitationProbability: 70,
      sunshine: 60,
    },
    {
      date: "2026-08-29",
      icon: "partly-cloudy-day",
      tempMin: 9,
      tempMax: 16,
      precipitation: 0,
      precipitationProbability: 10,
      sunshine: 300,
    },
  ],
};

const withLocale = (locale: string, child: () => ReturnType<typeof createComponent>) =>
  createComponent(LocaleProvider, {
    locale,
    get children() {
      return child();
    },
  });

describe("Weather SSR locale", () => {
  test("renders German display copy and German number formatting under the request provider", () => {
    const html = renderToString(() =>
      withLocale("de-CH", () =>
        createComponent(DetailDisplayView, {
          data,
          location: "Ulm",
          state: "Baden-Württemberg",
          zoom: 1,
          now: "2026-08-28T10:00:00.000Z",
          refreshSeconds: 60,
          refreshedAt: null,
        }),
      ),
    );

    expect(html).toContain("Aktuelle Messwerte");
    expect(html).toContain("Sichtweite");
    expect(html).toContain("10.5 km");
    expect(html).toContain("1'013 hPa");
    expect(html).toContain("Heute");
    expect(html).toContain("Morgen");
    expect(html).not.toContain("Current Conditions");
  });

  test("keeps independent SSR locale providers isolated", () => {
    const renderUnavailable = (locale: string, message: string) =>
      renderToString(() =>
        withLocale(locale, () => createComponent(DisplayUnavailable, { message, refreshSeconds: 60, refreshedAt: null, retrying: true })),
      );

    expect(renderUnavailable("de", "Nicht erreichbar")).toContain("Wetterdaten nicht verfügbar");
    expect(renderUnavailable("en", "Unavailable")).toContain("Weather data unavailable");
  });
});
