import type { WeatherScreenProps } from "./WeatherScreen";
import type { WeatherNow } from "./weather-view";

// Invented places and readings for the screen's tests: the usual day, and the worst case (long names, many places,
// missing readings, extreme values).
const hours = ["Jetzt", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00", "00:00", "01:00"];
const weather: WeatherNow = {
  icon: "sun-moon",
  condition: "leicht bewölkt",
  temperature: "12,4°",
  station: "Ulm-Mähringen",
  humidity: "71 %",
  clouds: "40 %",
  wind: "14 km/h",
  rain: "0 mm",
  pressure: "1.016 hPa",
  dewPoint: "7,2°",
  visibility: "24,5 km",
  sunshine: "38 min",
  hourly: hours.map((time, index) => ({
    time,
    icon: index > 6 ? "moon" : "sun-moon",
    condition: index > 6 ? "klar" : "leicht bewölkt",
    temperature: `${12 - Math.round(index / 2)}°`,
    rain: index === 4 ? "20 %" : "–",
  })),
  daily: ["Heute", "Morgen", "Fr. 27.", "Sa. 28.", "So. 29.", "Mo. 30.", "Di. 1."].map((day, index) => ({
    day,
    icon: index % 3 === 0 ? "cloud-rain" : "sun",
    condition: index % 3 === 0 ? "Regen" : "klar",
    range: `${3 + index}° / ${11 + index}°`,
    rain: index % 3 === 0 ? "80 %" : "–",
    sunshine: `${(index * 1.3).toFixed(1).replace(".", ",")} h`,
  })),
};
const open = { id: "ulm001", name: "Ulm", state: "Baden-Württemberg", lat: 48.4, lon: 10, geoapify: true };

export const weatherScreenFixtures: Record<string, WeatherScreenProps> = {
  record: {
    places: [
      { id: "ulm001", name: "Ulm", state: "Baden-Württemberg", icon: "sun-moon", temperature: "12,4°" },
      { id: "ber002", name: "Berlin", state: "Berlin", icon: "cloud", temperature: "8,1°" },
      { id: "hh0003", name: "Hamburg", state: "Hamburg", icon: "cloud-rain", temperature: "6,9°" },
    ],
    open,
    weather,
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
      condition: "Gewitter mit Hagel und Starkregen",
      temperature: "-27,8°",
      station: "Feldberg/Schwarzwald (Bergstation, automatisch)",
      humidity: "–",
      wind: "187 km/h",
      rain: "142,6 mm",
      pressure: "–",
      dewPoint: "–",
      visibility: "–",
      sunshine: "–",
      hourly: weather.hourly.map((hour) => ({ ...hour, condition: "Gewitter mit Hagel und Starkregen", rain: "100 %" })),
      daily: [],
    },
  },
};
