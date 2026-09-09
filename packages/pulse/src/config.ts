import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "pulse",
  name: "Pulse",
  icon: "ti ti-activity-heartbeat",
  description: "Metrics, events, states, and realtime dashboards.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: { description: "Metriken, Ereignisse, Zustände und Echtzeit-Dashboards." },
    },
  },
  appearance: { accent: "#1e40af", background: { from: "#1d4ed8", to: "#4f46e5", angle: 135 } },
  basePath: "/app/pulse",
  baseUrl: "http://app-pulse:3000",
  nav: {
    href: "/app/pulse",
    match: "/app/pulse",
    section: "primary",
    requiresAuth: true,
    requiresRoles: ["user"],
  },
  openapi: "/api/pulse/openapi.json",
  routes: ["/api/pulse", "/app/pulse", "/public/pulse"],
});

export const { ssr, plugin } = app;
