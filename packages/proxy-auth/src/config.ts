import { defineApp } from "@valentinkolb/cloud";

export const app = defineApp({
  id: "proxy-auth",
  name: "Proxy Auth",
  icon: "ti ti-load-balancer",
  description: "Configure forward-auth clients and verify callback access flows.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: { name: "Proxy-Authentifizierung", description: "Forward-Auth-Clients konfigurieren und Callback-Zugriffe prüfen." },
    },
  },
  appearance: { accent: "#334155", background: { from: "#475569", to: "#4f46e5", angle: 135 } },
  basePath: "/admin/proxy-auth",
  baseUrl: "http://app-proxy-auth:3000",
  adminHref: "/admin/proxy-auth",
  openapi: "/api/proxy-auth/openapi.json",
  // Top-level `/proxy-auth` for the Traefik forward-auth verify endpoint
  // — the URL must be configurable on the public origin without /api prefix.
  routes: ["/proxy-auth", "/api/proxy-auth", "/admin/proxy-auth", "/public/proxy-auth"],
});

export const { ssr, plugin } = app;
