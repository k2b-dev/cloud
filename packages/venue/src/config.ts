import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "venue",
  name: "Venues",
  icon: "ti ti-building-carousel",
  description: "Venues, opening hours, staffing shifts, public status pages, and anonymous feedback.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Standorte",
        description: "Standorte, Öffnungszeiten, Schichten, öffentliche Statusseiten und anonymes Feedback.",
      },
    },
  },
  appearance: { accent: "#a16207", background: { from: "#d97706", to: "#f59e0b", angle: 135 } },
  basePath: "/app/venue",
  baseUrl: "http://app-venue:3000",
  nav: {
    href: "/app/venue",
    match: "/app/venue",
    section: "primary",
    requiresAuth: true,
    requiresRoles: ["user"],
  },
  widgets: [{ id: "today", path: "/api/venue/widget/today" }],
  openapi: "/api/venue/openapi.json",
  routes: ["/api/venue", "/app/venue", "/public/venue"],
});

// fallow-ignore-next-line unused-export
export const { ssr, plugin } = app;
