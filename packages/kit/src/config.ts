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
  adminHref: "/admin/kit",
  settings: {
    "kit.rsql_enabled": {
      kind: "boolean",
      default: false,
      label: "Shared databases",
      presentation: { translations: { de: { label: "Gemeinsame Datenbanken" } } },
    },
    "kit.rsql_url": {
      kind: "string",
      default: "",
      envFallback: () => process.env.KIT_RSQL_URL,
      label: "rsql server URL",
      presentation: { translations: { de: { label: "rsql-Serveradresse" } } },
    },
    "kit.rsql_api_token": {
      kind: "secret",
      default: "",
      envFallback: () => process.env.KIT_RSQL_API_TOKEN,
      label: "rsql API token",
      presentation: { translations: { de: { label: "rsql-API-Token" } } },
    },
  },
  basePath: "/app/kit",
  baseUrl: "http://app-kit:3000",
  routes: ["/app/kit", "/api/kit", "/public/kit", "/admin/kit"],
  nav: { href: "/app/kit", section: "primary", requiresAuth: true },
  openapi: "/api/kit/openapi.json",
});
export const { ssr, plugin } = app;
