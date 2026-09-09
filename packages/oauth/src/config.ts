import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "oauth",
  name: "OAuth",
  icon: "ti ti-key",
  description: "Manage OAuth/OIDC clients, redirects, scopes, and secrets.",
  presentation: {
    baseLocale: "en",
    translations: { de: { description: "OAuth/OIDC-Clients, Weiterleitungen, Scopes und Secrets verwalten." } },
  },
  appearance: { accent: "#4338ca", background: { from: "#4f46e5", to: "#8b5cf6", angle: 135 } },
  basePath: "/oauth",
  baseUrl: "http://app-oauth:3000",
  adminHref: "/admin/oauth",
  openapi: "/api/oauth/openapi.json",
  // OAuth needs RFC-mandated top-level paths (/oauth/authorize, /oauth/token,
  // /.well-known/openid-configuration, /.well-known/jwks.json) plus the
  // platform-standard admin UI + admin API.
  routes: [
    "/oauth",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
    "/.well-known/jwks.json",
    "/api/oauth",
    "/admin/oauth",
    "/public/oauth",
  ],
});

export const { ssr, plugin } = app;
