import { defineApp } from "@k2b/cloud";
import { SKILLS } from "./skills";

export const app = defineApp({
  id: "spaces",
  cli: { spaces: { module: "src/cli.ts", references: "src/cli-references" } },
  name: "Spaces",
  icon: "ti ti-layout-kanban",
  description: "Plan, track, and collaborate on boards, tasks, and events.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        description: "Aufgaben und Termine gemeinsam in übersichtlichen Spaces planen und bearbeiten.",
        widgets: { today: { title: "Heute", description: "Termine und fällige To-dos von heute aus allen deinen Spaces." } },
      },
    },
  },
  appearance: { accent: "#4d7c0f", background: { from: "#65a30d", to: "#84cc16", angle: 135 } },
  basePath: "/app/spaces",
  baseUrl: "http://app-spaces:3000",
  skills: SKILLS,
  adminHref: "/admin/spaces",
  nav: {
    href: "/app/spaces?recent=true",
    match: "/app/spaces",
    section: "primary",
    requiresAuth: true,
    requiresRoles: ["user"],
  },
  // "My tasks" in the mobile app at /pwa/spaces, for the same people as the web navigation.
  pwa: { requiresRoles: ["user"] },
  widgets: [
    {
      id: "today",
      path: "/api/spaces/widget/today",
      title: "Today",
      description: "Today's events and due to-dos from all your spaces.",
      sizes: ["medium", "large"],
      defaultSize: "large",
      suggest: true,
    },
  ],
  openapi: "/api/spaces/openapi.json",
  routes: ["/api/spaces", "/app/spaces", "/admin/spaces", "/public/spaces"],
});

export const { ssr, plugin } = app;
