import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "spaces",
  name: "Spaces",
  icon: "ti ti-layout-kanban",
  description: "Plan, track, and collaborate on boards, tasks, and events.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: { description: "Aufgaben und Termine gemeinsam in übersichtlichen Spaces planen und bearbeiten." },
    },
  },
  appearance: { accent: "#4d7c0f", background: { from: "#65a30d", to: "#84cc16", angle: 135 } },
  basePath: "/app/spaces",
  baseUrl: "http://app-spaces:3000",
  adminHref: "/admin/spaces",
  nav: {
    href: "/app/spaces?recent=true",
    match: "/app/spaces",
    section: "primary",
    requiresAuth: true,
    requiresRoles: ["user"],
  },
  widgets: [
    {
      id: "today",
      path: "/api/spaces/widget/today",
      presentation: { defaultZone: "focus", defaultSpan: "wide" },
    },
  ],
  openapi: "/api/spaces/openapi.json",
  routes: ["/api/spaces", "/app/spaces", "/admin/spaces", "/public/spaces"],
});

export const { ssr, plugin } = app;
