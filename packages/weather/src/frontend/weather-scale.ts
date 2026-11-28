/**
 * The colours of weather: one place for every colour the weather screen draws with, so no component carries a colour
 * of its own. Each colour has a light and a dark value (`light-dark()`, the page's colour scheme picks one), and each
 * value keeps at least 3:1 against the surface it stands on (white, and #11151b in the dark), as WCAG asks of
 * graphical objects. Text never takes these colours; it stays in the text ink.
 */

/** One colour in both themes. */
export type ThemeColor = { light: string; dark: string };

/** The page surfaces the colours stand on (`--k2-surface` light and dark). */
export const WEATHER_SURFACES = { light: "#ffffff", dark: "#11151b" } as const;

/** Cold to warm, a stop every 5°: an ordinary day already spans two colours; between two stops the colour runs over. */
export const TEMPERATURE_STOPS: readonly { at: number; color: ThemeColor }[] = [
  { at: -10, color: { light: "#4338ca", dark: "#a5b4fc" } },
  { at: -5, color: { light: "#1d4ed8", dark: "#93c5fd" } },
  { at: 0, color: { light: "#0369a1", dark: "#38bdf8" } },
  { at: 5, color: { light: "#0f766e", dark: "#2dd4bf" } },
  { at: 10, color: { light: "#15803d", dark: "#4ade80" } },
  { at: 15, color: { light: "#a16207", dark: "#facc15" } },
  { at: 20, color: { light: "#c2410c", dark: "#fb923c" } },
  { at: 25, color: { light: "#dc2626", dark: "#f87171" } },
  { at: 30, color: { light: "#9f1239", dark: "#fb7185" } },
];

/** What a weather sign shows, by the provider's condition: sun amber, rain blue, snow ice-blue, thunder violet. */
export type WeatherTone = "sun" | "rain" | "snow" | "thunder" | "plain";

export const TONE_COLORS: Record<Exclude<WeatherTone, "plain">, ThemeColor> = {
  sun: { light: "#b45309", dark: "#fbbf24" },
  rain: { light: "#2563eb", dark: "#60a5fa" },
  snow: { light: "#0e7490", dark: "#67e8f9" },
  thunder: { light: "#7c3aed", dark: "#a78bfa" },
};

/** The rain of the phone's day: a softer blue for its thin bars, still at 3:1 on the surface. */
export const RAIN_SOFT: ThemeColor = { light: "#3b82f6", dark: "#93c5fd" };

/** The tone of a condition code (`clear-day`, `rain`, …); clouds, fog, wind and the night stay plain. */
export const weatherTone = (condition: string): WeatherTone => {
  switch (condition) {
    case "clear-day":
    case "partly-cloudy-day":
      return "sun";
    case "rain":
    case "sleet":
      return "rain";
    case "snow":
    case "hail":
      return "snow";
    case "thunderstorm":
      return "thunder";
    default:
      return "plain";
  }
};

const channels = (hex: string) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
const toHex = (values: number[]) => `#${values.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;

/** The colour of a temperature in one theme: the stops run over in between, and hold beyond the ends. */
export const temperatureHex = (degrees: number, theme: keyof ThemeColor): string => {
  const stops = TEMPERATURE_STOPS;
  if (degrees <= stops[0]!.at) return stops[0]!.color[theme];
  for (let index = 1; index < stops.length; index++) {
    const upper = stops[index]!;
    if (degrees > upper.at) continue;
    const lower = stops[index - 1]!;
    const share = (degrees - lower.at) / (upper.at - lower.at);
    const from = channels(lower.color[theme]);
    const to = channels(upper.color[theme]);
    return toHex(from.map((value, channel) => value + (to[channel]! - value) * share));
  }
  return stops.at(-1)!.color[theme];
};

/** A colour for CSS: the page's colour scheme takes the light or the dark value. */
export const cssColor = (color: ThemeColor) => `light-dark(${color.light}, ${color.dark})`;

/** The colour of a temperature for CSS, in both themes. */
export const temperatureColor = (degrees: number) =>
  cssColor({ light: temperatureHex(degrees, "light"), dark: temperatureHex(degrees, "dark") });

/** The scale's stops for CSS, as a `RangeBar` takes them: the week's bars run cold to warm along it. */
export const temperatureStops = TEMPERATURE_STOPS.map((stop) => ({ at: stop.at, color: cssColor(stop.color) }));

/** The colour of a weather sign for CSS; a plain sign keeps the quiet ink of the page. */
export const toneColor = (tone: WeatherTone) => (tone === "plain" ? "var(--k2-muted)" : cssColor(TONE_COLORS[tone]));
