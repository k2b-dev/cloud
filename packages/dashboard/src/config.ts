import { defineApp } from "@valentinkolb/cloud";

export const app = defineApp({
  id: "dashboard",
  name: "Dashboard",
  icon: "ti ti-layout-dashboard",
  description: "User home — composable widgets from every app on the platform.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: { description: "Persönliche Startseite mit Widgets aus allen Apps der Plattform." },
    },
  },
  appearance: { accent: "#2563eb", background: { from: "#2563eb", to: "#60a5fa", angle: 135 } },
  basePath: "/app/dashboard",
  baseUrl: "http://app-dashboard:3000",
  // `section: "hidden"` keeps the dashboard out of the rail (users land here
  // via `/` → `/app/dashboard`).
  nav: { href: "/app/dashboard", match: "/app/dashboard", section: "hidden" },
  routes: ["/api/dashboard", "/app/dashboard", "/public/dashboard"],
});

export const { ssr, plugin } = app;
