export const WEATHER_SETTINGS = {
  "weather.default_lat": {
    kind: "string",
    label: "Default Latitude",
    default: "",
    description: "Default latitude shown in weather widgets",
    placeholder: "e.g. 48.401082 (Ulm)",
    presentation: {
      translations: {
        de: {
          label: "Standardbreitengrad",
          description: "In Wetter-Widgets angezeigter Standardbreitengrad",
          placeholder: "z. B. 48.401082 (Ulm)",
        },
      },
    },
  },
  "weather.default_lon": {
    kind: "string",
    label: "Default Longitude",
    default: "",
    description: "Default longitude shown in weather widgets",
    placeholder: "e.g. 9.987608 (Ulm)",
    presentation: {
      translations: {
        de: {
          label: "Standardlängengrad",
          description: "In Wetter-Widgets angezeigter Standardlängengrad",
          placeholder: "z. B. 9.987608 (Ulm)",
        },
      },
    },
  },
  "weather.cache_minutes": {
    kind: "number",
    label: "Cache TTL (minutes)",
    default: 30,
    min: 1,
    max: 1440,
    description: "How long weather data is cached before fetching fresh data (in minutes)",
    presentation: {
      translations: {
        de: {
          label: "Cache-TTL (Minuten)",
          description: "Dauer in Minuten, für die Wetterdaten vor dem nächsten Abruf zwischengespeichert werden",
        },
      },
    },
  },
  "weather.geo_url": {
    kind: "url",
    label: "Geo API URL",
    default: "",
    description: "Geocoding API URL for the location search feature",
    placeholder: "e.g. https://geocoding.example.com/search",
    presentation: {
      translations: {
        de: {
          label: "Geo-API-URL",
          description: "Geocoding-API-URL für die Ortssuche",
          placeholder: "z. B. https://geocoding.example.com/search",
        },
      },
    },
  },
} as const;
