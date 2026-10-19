import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { WeatherDataPayload } from "../../contracts";

const root = mkdtempSync(join(tmpdir(), "weather-display-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ SimpleDisplayView, DetailDisplayView, DisplayUnavailable }, { LocaleProvider }] = await Promise.all([
  import("./DisplayViews"),
  import("@k2b/ui"),
]);

const now = "2026-10-19T10:00:00.000Z";
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
    pressure: 1013,
    visibility: 10500,
    dewPoint: 8.5,
    sunshine: 0,
    stationName: "Ulm",
    timestamp: now,
  },
  hourly: [now, "2026-10-19T11:00:00.000Z"].map<WeatherDataPayload["hourly"][number]>((timestamp) => ({
    timestamp,
    temperature: 12,
    icon: "rain",
    precipitation: 1.5,
    precipitationProbability: 60,
    windSpeed: 9,
    cloudCover: 75,
  })),
  daily: [],
};
const props = { data, location: "Ulm", state: "Baden-Württemberg", zoom: 1 as const, now, refreshSeconds: 60, refreshedAt: now };
const render = (child: () => ReturnType<typeof createComponent>) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return child();
      },
    }),
  ).replace(/<!--[\s\S]*?-->/g, "");

const expectDimmed = (elements: string[], count: number) => {
  expect(elements).toHaveLength(count);
  for (const element of elements) expect(element).toMatch(/class="[^"]*\btext-dimmed\b[^"]*"/);
};
const hourLabel = (timestamp: string) =>
  new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(new Date(timestamp));

// Check rendered elements, including inherited ink on the stats and detail time.
describe("weather display semantic ink", () => {
  test("simple view uses dimmed metadata and readable precipitation ink", () => {
    const html = render(() => createComponent(SimpleDisplayView, props));
    expect(html).not.toMatch(/text-zinc-[3-6]00/);
    expectDimmed(html.match(/<p\b[^>]*>Baden-Württemberg<\/p>/g) ?? [], 1);
    expectDimmed(html.match(/<dl\b[^>]*>/g) ?? [], 1);
    expectDimmed(html.match(/<time\b[^>]*>/g) ?? [], 1);
    const labels = [...html.matchAll(/<span\b[^>]*>([^<]*)<\/span>/g)]
      .filter((match) => data.hourly.some((hour) => match[1] === hourLabel(hour.timestamp)))
      .map((match) => match[0]);
    expectDimmed(labels, 2);
    const rain = [...html.matchAll(/<span\b[^>]*>[\s\S]*?<\/span>/g)].filter((match) => match[0].includes("60%"));
    expect(rain).toHaveLength(2);
    for (const [element] of rain) {
      const classes = /class="([^"]*)"/.exec(element)![1]!.split(/\s+/);
      expect(classes).toContain("text-blue-600");
      expect(classes).not.toContain("text-blue-400");
    }
  });

  test("detail view keeps metadata dimmed and condition values secondary", () => {
    const html = render(() => createComponent(DetailDisplayView, props));
    expect(html).not.toMatch(/text-zinc-[3-6]00/);
    expectDimmed(html.match(/<p\b[^>]*>Baden-Württemberg[^<]*<time\b[^>]*>/g) ?? [], 1);
    expectDimmed(html.match(/<dl\b[^>]*class="flex[^>]*>/g) ?? [], 1);
    expectDimmed(html.match(/<h2\b[^>]*>/g) ?? [], 3);
    const laterHour = [...html.matchAll(/<span\b[^>]*>([^<]*)<\/span>/g)]
      .filter((match) => match[1] === hourLabel(data.hourly[1]!.timestamp))
      .map((match) => match[0]);
    expectDimmed(laterHour, 1);
    const conditions = /<dl\b[^>]*class="grid grid-cols-4[^>]*>([\s\S]*?)<\/dl>/.exec(html)?.[1] ?? "";
    expectDimmed(conditions.match(/<dt\b[^>]*>/g) ?? [], 4);
    const values = conditions.match(/<dd\b[^>]*>/g) ?? [];
    expect(values).toHaveLength(4);
    for (const value of values) expect(value).toMatch(/class="[^"]*\btext-secondary\b[^"]*"/);
  });

  test("unavailable and retry messages use dimmed ink", () => {
    const html = render(() =>
      createComponent(DisplayUnavailable, { message: "Station unavailable", refreshSeconds: 60, refreshedAt: now, retrying: true }),
    );
    expect(html).not.toMatch(/text-zinc-[3-6]00/);
    expect(html).toContain("Station unavailable");
    expectDimmed(html.match(/<p\b[^>]*>/g) ?? [], 2);
  });
});
