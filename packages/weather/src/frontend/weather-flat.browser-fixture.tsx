import type { WeatherData } from "@k2b/cloud/services";
import { LocaleProvider, PageTrailProvider } from "@k2b/ui";
import WeatherWorkspace from "./_components/WeatherWorkspace";

// Invented places and readings only; the clock is frozen at the timestamps below.
const NOW = "2026-11-21T10:00:00.000Z";

const PLACES = [
  { id: "ulm", name: "Ulm", state: "Baden-Württemberg", lat: 48.4, lon: 10 },
  { id: "konstanz", name: "Konstanz", state: "Baden-Württemberg", lat: 47.66, lon: 9.18 },
  { id: "freiburg", name: "Freiburg im Breisgau", state: "Baden-Württemberg", lat: 47.99, lon: 7.85 },
  { id: "lindau", name: "Lindau (Bodensee)", state: "Bayern", lat: 47.55, lon: 9.68 },
  { id: "kempten", name: "Kempten (Allgäu)", state: "Bayern", lat: 47.72, lon: 10.31 },
  { id: "regensburg", name: "Regensburg", state: "Bayern", lat: 49.01, lon: 12.1 },
  { id: "jena", name: "Jena", state: "Thüringen", lat: 50.93, lon: 11.59 },
  { id: "rostock", name: "Rostock", state: "Mecklenburg-Vorpommern", lat: 54.09, lon: 12.1 },
  { id: "kiel", name: "Kiel", state: "Schleswig-Holstein", lat: 54.32, lon: 10.12 },
  { id: "trier", name: "Trier", state: "Rheinland-Pfalz", lat: 49.75, lon: 6.64 },
  { id: "goerlitz", name: "Görlitz", state: "Sachsen", lat: 51.15, lon: 14.99 },
  { id: "aachen", name: "Aachen", state: "Nordrhein-Westfalen", lat: 50.78, lon: 6.08 },
];

const ICONS = ["partly-cloudy-day", "cloudy", "rain", "clear-day", "fog", "snow"] as const;

const reading = (seed: number, full: boolean): WeatherData => ({
  current: {
    temperature: 4 + seed * 1.3,
    icon: ICONS[seed % ICONS.length]!,
    cloudCover: 60,
    windSpeed: 12,
    windGust: null,
    windDirection: 220,
    humidity: 81,
    precipitation: 0.4,
    pressure: 1_016,
    visibility: 14_000,
    dewPoint: 2.1,
    sunshine: 18,
    stationName: "Ulm-Mähringen",
    timestamp: NOW,
  },
  hourly: full
    ? Array.from({ length: 24 }, (_, hour) => ({
        timestamp: new Date(Date.parse(NOW) + hour * 3_600_000).toISOString(),
        temperature: 3 + Math.sin(hour / 4) * 4,
        icon: ICONS[hour % 4]!,
        precipitation: hour % 5 === 0 ? 0.6 : 0,
        precipitationProbability: hour % 5 === 0 ? 40 : 0,
        windSpeed: 10,
        cloudCover: 50,
      }))
    : [],
  daily: Array.from({ length: full ? 7 : 2 }, (_, day) => ({
    date: new Date(Date.parse(NOW) + day * 86_400_000).toISOString().slice(0, 10),
    tempMin: -1 + day,
    tempMax: 6 + day,
    icon: ICONS[(day + 1) % ICONS.length]!,
    precipitation: day % 2 ? 2.4 : 0,
    precipitationProbability: day % 2 ? 70 : 10,
    sunshine: day % 2 ? 0 : 240,
  })),
});

export type WeatherScenario = "few" | "many" | "unavailable" | "missing";

/** The weather workspace of one scenario: two places and a short forecast, twelve places and a full one, a place
 * without a forecast, and an unknown place. */
export default function WeatherFlatFixture(props: { scenario: WeatherScenario }) {
  const full = props.scenario !== "few";
  const locations = props.scenario === "few" ? PLACES.slice(0, 2) : PLACES;
  const weatherMap = new Map(locations.map((place, index) => [place.id, index === 3 ? null : reading(index, false)] as const));
  const activeId = props.scenario === "missing" ? "gone" : "ulm";
  return (
    <LocaleProvider locale="de">
      <PageTrailProvider
        trail={{ title: props.scenario === "missing" ? "Nicht gefunden" : "Ulm", ancestors: [{ title: "Wetter", href: "/app/weather" }] }}
      >
        <WeatherWorkspace
          locations={locations}
          activeId={activeId}
          weatherMap={weatherMap}
          data={props.scenario === "unavailable" ? null : reading(0, full)}
        />
      </PageTrailProvider>
    </LocaleProvider>
  );
}
