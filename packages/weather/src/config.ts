import { defineApp } from "@k2b/cloud";
import { WEATHER_SETTINGS } from "@k2b/cloud/services/weather/settings";
import { SKILLS } from "./skills";

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
        widgets: { current: { title: "Wetter", description: "Das aktuelle Wetter an deinen gespeicherten Orten." } },
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
  skills: SKILLS,
  adminHref: "/admin/weather",
  nav: {
    href: "/app/weather",
    match: "/app/weather",
    section: "more",
    requiresAuth: true,
    requiresRoles: ["user"],
  },
  widgets: [
    {
      id: "current",
      path: "/api/weather/widget/current",
      title: "Weather",
      description: "Current weather at your saved places.",
      sizes: ["small", "medium", "large"],
      defaultSize: "small",
      suggest: true,
      // Recommended before sizes existed; the dashboard reads it only to convert boards saved then.
      presentation: { defaultZone: "context" },
    },
  ],
  openapi: "/api/weather/openapi.json",
  routes: ["/api/weather", "/app/weather", "/admin/weather", "/public/weather"],
  settings: WEATHER_SETTINGS,
});

export const { ssr, plugin } = app;
