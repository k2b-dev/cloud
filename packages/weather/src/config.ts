import { defineApp } from "@valentinkolb/cloud";
import { WEATHER_SETTINGS } from "@valentinkolb/cloud/services/weather/settings";

export const app = defineApp({
  id: "weather",
  name: "Weather",
  icon: "ti ti-temperature-celsius",
  description: "Forecasts, saved locations, and weather widgets.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Wetter",
        description: "Vorhersagen, gespeicherte Orte und Wetter-Widgets.",
      },
    },
  },
  appearance: {
    accent: "#0369a1",
    background: {
      from: "#3b82f6",
      via: "#ffffff",
      to: "#facc15",
      angle: 135,
      strength: 12,
    },
  },
  basePath: "/app/weather",
  baseUrl: "http://app-weather:3000",
  adminHref: "/admin/weather",
  nav: {
    href: "/app/weather",
    match: "/app/weather",
    section: "more",
    requiresAuth: true,
  },
  widgets: [{ id: "current", path: "/api/weather/widget/current", presentation: { defaultZone: "context" } }],
  openapi: "/api/weather/openapi.json",
  routes: ["/api/weather", "/app/weather", "/admin/weather", "/public/weather"],
  settings: WEATHER_SETTINGS,
});

export const { ssr, plugin } = app;
