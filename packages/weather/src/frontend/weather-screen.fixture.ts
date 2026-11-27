import type { WeatherScreenProps } from "./WeatherScreen";
import type { WeatherTone } from "./weather-scale";
import type { WeatherNow } from "./weather-view";

// Invented places and readings for the screen's tests: the usual day, and the worst case (long names, many places,
// missing readings, extreme values).
// An ordinary late-November afternoon in Ulm: mild, rain from the early evening, a cold clear night after it.
const hours = ["Jetzt", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00", "00:00", "01:00"];
const degrees = [8.4, 8.9, 8.6, 7.9, 7.1, 6.6, 6.2, 5.4, 4.8, 4.1, 3.6, 3.2];
const chances = [0, 10, 30, 60, 80, 70, 40, 20, 0, 0, 0, 0];
// sign, words, tone, and whether the hour lies in the dark (the provider's night sign)
const conditions: [string, string, WeatherTone, boolean][] = [
  ["cloud", "bewölkt", "plain", false],
  ["cloud", "bewölkt", "plain", false],
  ["cloud", "bewölkt", "plain", false],
  ["cloud-rain", "Regen", "rain", false],
  ["cloud-rain", "Regen", "rain", true],
  ["cloud-rain", "Regen", "rain", true],
  ["cloud", "bewölkt", "plain", true],
  ["cloud-fog", "Nebel", "plain", true],
  ["moon", "klar", "plain", true],
  ["moon", "klar", "plain", true],
  ["moon", "klar", "plain", true],
  ["moon", "klar", "plain", true],
];
const comma = (value: number) => value.toFixed(1).replace(".", ",");
const weather: WeatherNow = {
  icon: "cloud",
  tone: "plain",
  condition: "bewölkt",
  temperature: "8,4°",
  degrees: 8.4,
  station: "Ulm-Mähringen",
  humidity: "78 %",
  clouds: "85 %",
  wind: "17 km/h",
  rain: "0 mm",
  pressure: "1.009 hPa",
  dewPoint: "4,8°",
  visibility: "18,5 km",
  sunshine: "0 min",
  today: { low: "2,9°", high: "9,1°" },
  alerts: ["Regen ab 17:00 · 60 %"],
  hourly: hours.map((time, index) => ({
    time,
    icon: conditions[index]![0],
    tone: conditions[index]![2],
    condition: conditions[index]![1],
    temperature: `${comma(degrees[index]!)}°`,
    degrees: degrees[index]!,
    night: conditions[index]![3],
    rain: chances[index] ? `${chances[index]} %` : "–",
    rainChance: chances[index] || null,
  })),
  daily: (
    [
      ["Heute", "cloud-rain", "rain", "Regen", 2.9, 9.1, 80, "0,4 h"],
      ["Morgen", "cloud", "plain", "bewölkt", 1.8, 6.4, 20, "1,2 h"],
      ["Sa. 28.", "sun", "sun", "klar", -2.1, 5.2, 0, "6,8 h"],
      ["So. 29.", "sun", "sun", "klar", -3.4, 4.6, 0, "7,1 h"],
      ["Mo. 30.", "cloud-snow", "snow", "Schnee", -1.2, 2.0, 70, "0 h"],
      ["Di. 1.", "cloud", "plain", "bewölkt", 0.4, 3.8, 30, "1,9 h"],
      ["Mi. 2.", "cloud-rain", "rain", "Regen", 2.2, 7.5, 60, "0,8 h"],
    ] as const
  ).map(([day, icon, tone, condition, low, high, chance, sunshine]) => ({
    day,
    icon,
    tone,
    condition,
    range: `${comma(low)}° / ${comma(high)}°`,
    low,
    high,
    rain: chance ? `${chance} %` : "–",
    rainChance: chance || null,
    sunshine,
  })),
};
const open = { id: "ulm001", name: "Ulm", state: "Baden-Württemberg", lat: 48.4, lon: 10, geoapify: true };

export const weatherScreenFixtures: Record<string, WeatherScreenProps> = {
  record: {
    places: [
      { id: "ulm001", name: "Ulm", state: "Baden-Württemberg", icon: "cloud", temperature: "8,4°" },
      { id: "ber002", name: "Berlin", state: "Berlin", icon: "cloud", temperature: "5,1°" },
      { id: "hh0003", name: "Hamburg", state: "Hamburg", icon: "cloud-rain", temperature: "6,9°" },
      { id: "muc004", name: "München", state: "Bayern", icon: "sun", temperature: "7,3°" },
      { id: "fr0005", name: "Freiburg im Breisgau", state: "Baden-Württemberg", icon: "cloud-fog", temperature: "9,8°" },
      { id: "sy0006", name: "Sylt", state: "Schleswig-Holstein", icon: "wind", temperature: "6,2°" },
      { id: "zug007", name: "Garmisch-Partenkirchen", state: "Bayern", icon: "snowflake", temperature: "-1,4°" },
      // two places of the same name: the sidebar tells them apart by their state
      { id: "nst008", name: "Neustadt", state: "Hessen", icon: "cloud", temperature: "6,0°" },
      { id: "nst009", name: "Neustadt", state: "Sachsen", icon: "cloud-snow", temperature: "0,8°" },
    ],
    open,
    weather,
  },
  // one saved place on a quiet day: no exception in the hero, a single entry in the sidebar
  one: {
    places: [{ id: "ulm001", name: "Ulm", state: null, icon: "sun", temperature: "0°" }],
    open: { ...open, state: null, geoapify: false },
    weather: { ...weather, icon: "sun", tone: "sun", condition: "klar", temperature: "0°", degrees: 0, alerts: [] },
  },
  empty: { places: [], open: null, weather: null },
  missing: {
    places: [{ id: "ulm001", name: "Ulm", state: "Baden-Württemberg", icon: "sun-moon", temperature: "12,4°" }],
    open: null,
    missing: true,
    weather: null,
  },
  failed: {
    places: [{ id: "ulm001", name: "Ulm", state: "Baden-Württemberg", icon: "map-pin", temperature: null }],
    open,
    weather: null,
  },
  worst: {
    places: Array.from({ length: 24 }, (_, index) => ({
      id: `w${String(index).padStart(5, "0")}`,
      name: index === 0 ? "Schwäbisch Gmünd-Straßdorf an der Rems im Ostalbkreis" : `Ort ${index} mit einem langen Namen`,
      state: "Mecklenburg-Vorpommern",
      icon: index % 2 ? "snowflake" : "cloud-storm",
      temperature: index % 5 === 0 ? null : "-27,8°",
    })),
    open: {
      id: "w00000",
      name: "Schwäbisch Gmünd-Straßdorf an der Rems im Ostalbkreis",
      state: "Mecklenburg-Vorpommern",
      lat: 48.8,
      lon: 9.8,
      geoapify: false,
    },
    weather: {
      ...weather,
      icon: "cloud-storm",
      tone: "thunder",
      condition: "Gewitter mit Hagel und Starkregen",
      temperature: "-27,8°",
      degrees: -27.8,
      station: "Feldberg/Schwarzwald (Bergstation, automatisch)",
      humidity: "–",
      wind: "187 km/h",
      rain: "142,6 mm",
      pressure: "–",
      dewPoint: "–",
      visibility: "–",
      sunshine: "–",
      today: null,
      alerts: ["Regen ab Jetzt · 100 %", "Böen bis 187 km/h"],
      hourly: weather.hourly.map((hour, index) => ({
        ...hour,
        icon: "cloud-storm",
        tone: "thunder" as const,
        condition: "Gewitter mit Hagel und Starkregen",
        temperature: "-27,8°",
        degrees: -27.8 + index * 0.1,
        rain: "100 %",
        rainChance: 100,
      })),
      daily: [],
    },
  },
};
