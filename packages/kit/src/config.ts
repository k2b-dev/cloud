import { defineApp } from "@k2b/cloud";
export const app = defineApp({
  id: "kit",
  name: "Kit",
  icon: "ti ti-code",
  description: "Build and share local browser tools.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: { description: "Lokale Browser-Werkzeuge erstellen und teilen." },
    },
  },
  basePath: "/app/kit",
  baseUrl: "http://app-kit:3000",
  routes: ["/app/kit", "/api/kit", "/public/kit"],
  nav: { href: "/app/kit", section: "primary", requiresAuth: true },
  openapi: "/api/kit/openapi.json",
});
export const { ssr, plugin } = app;
