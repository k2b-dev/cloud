import { describe, expect, test } from "bun:test";
import { RAIN_SOFT, TEMPERATURE_STOPS, TONE_COLORS, temperatureHex, WEATHER_SURFACES, weatherTone } from "./weather-scale";

// WCAG relative luminance and contrast ratio.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

describe("the colours of weather", () => {
  test("every temperature from -30° to 45° keeps 3:1 against the surface, light and dark", () => {
    for (const theme of ["light", "dark"] as const) {
      for (let degrees = -30; degrees <= 45; degrees += 0.5) {
        const color = temperatureHex(degrees, theme);
        expect({ theme, degrees, enough: contrast(color, WEATHER_SURFACES[theme]) >= 3 }).toEqual({ theme, degrees, enough: true });
      }
    }
  });

  test("the scale runs from cold to warm and holds beyond its ends", () => {
    expect(temperatureHex(-40, "light")).toBe(TEMPERATURE_STOPS[0]!.color.light);
    expect(temperatureHex(0, "dark")).toBe(TEMPERATURE_STOPS[2]!.color.dark);
    expect(temperatureHex(50, "light")).toBe(TEMPERATURE_STOPS.at(-1)!.color.light);
    // halfway between two stops lies between their colours
    expect(temperatureHex(5, "light")).not.toBe(temperatureHex(0, "light"));
    expect(temperatureHex(5, "light")).not.toBe(temperatureHex(10, "light"));
  });

  test("each weather sign and the phone's soft rain keep 3:1 against the surface, light and dark", () => {
    for (const [tone, color] of Object.entries({ ...TONE_COLORS, rainSoft: RAIN_SOFT }))
      for (const theme of ["light", "dark"] as const)
        expect({ tone, theme, enough: contrast(color[theme], WEATHER_SURFACES[theme]) >= 3 }).toEqual({ tone, theme, enough: true });
  });

  test("sun is amber, rain blue, snow ice-blue, thunder violet; clouds and the night stay plain", () => {
    expect(["clear-day", "rain", "sleet", "snow", "hail", "thunderstorm", "cloudy", "fog", "clear-night"].map(weatherTone)).toEqual([
      "sun",
      "rain",
      "rain",
      "snow",
      "snow",
      "thunder",
      "plain",
      "plain",
      "plain",
    ]);
  });
});
