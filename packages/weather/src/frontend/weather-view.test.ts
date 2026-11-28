import { describe, expect, test } from "bun:test";
import type { WeatherDataPayload } from "../contracts";
import { weatherMessages } from "../messages";
import { weatherFormat } from "./weather-view";

// An invented afternoon: the hero's facts come only from the forecast the provider gave.
const now = new Date("2026-11-26T13:30:00.000Z");
const hourly = (chances: (number | null)[]): WeatherDataPayload["hourly"] =>
  chances.map((chance, index) => ({
    timestamp: new Date(Date.UTC(2026, 10, 26, 13 + index)).toISOString(),
    temperature: 8 - index * 0.5,
    icon: "cloudy",
    precipitation: 0,
    precipitationProbability: chance,
    windSpeed: 10,
    cloudCover: 80,
  }));
const data = (overrides: { chances?: (number | null)[]; gust?: number | null; daily?: boolean } = {}): WeatherDataPayload => ({
  current: {
    temperature: 8.4,
    icon: "cloudy",
    cloudCover: 85,
    windSpeed: 17,
    windGust: overrides.gust ?? null,
    windDirection: 220,
    humidity: 78,
    precipitation: 0,
    pressure: 1009,
    visibility: 18_500,
    dewPoint: 4.8,
    sunshine: 0,
    stationName: "Ulm-Mähringen",
    timestamp: now.toISOString(),
  },
  hourly: hourly(overrides.chances ?? [0, 10, 30, 60, 80]),
  daily:
    overrides.daily === false
      ? []
      : [{ date: "2026-11-26", icon: "rain", tempMin: 2.9, tempMax: 9.1, precipitation: 3.2, precipitationProbability: 80, sunshine: 24 }],
});

const plain = (texts: string[]) => texts.map((text) => text.replace(/[\u00a0\u202f]/g, " "));

describe("the weather of a location in the reader's words", () => {
  const { t } = weatherMessages.resolve(["de"]);
  const format = weatherFormat("de", t, now);

  test("says from which hour rain is more likely than not, and today's low and high", () => {
    const weather = format.weather(data());
    expect(plain(weather.alerts)).toEqual(["Regen ab 17:00 · 60 %"]);
    expect(weather.today).toEqual({ low: "2,9°", high: "9,1°" });
    expect(weather.hourly.map((hour) => hour.rainChance)).toEqual([null, 10, 30, 60, 80]);
    expect(weather.hourly[0]).toMatchObject({ time: "Jetzt", degrees: 8, rain: "–" });
  });

  test("stays quiet on an ordinary day without a daily forecast", () => {
    const weather = format.weather(data({ chances: [0, 20, 40, null], gust: 49, daily: false }));
    expect(weather.alerts).toEqual([]);
    expect(weather.today).toBeNull();
  });

  test("names rain that is likely now and gusts from the DWD's lowest warning level", () => {
    expect(plain(format.weather(data({ chances: [50, 90], gust: 50 })).alerts)).toEqual(["Regen ab Jetzt · 50 %", "Böen bis 50 km/h"]);
  });
});
