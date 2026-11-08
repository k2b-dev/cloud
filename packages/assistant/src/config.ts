import { appAccess, defineApp } from "@k2b/cloud";
import { SKILLS } from "./skills";

export const app = defineApp({
  id: "assistant",
  access: appAccess.signedIn({
    publicRoutes: ["/_internal/assistant/tools/*", "/api/assistant/openapi.json"],
  }),
  cli: { assistant: { module: "src/cli.ts", references: "src/cli-references" } },
  name: "Gustav",
  icon: "ti ti-moustache",
  description: "General-purpose AI assistant for writing, rewriting, summarizing, and questions.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Gustav",
        panelLabel: "Gustav",
        description: "KI-Assistent zum Schreiben, Überarbeiten, Zusammenfassen und Beantworten von Fragen.",
      },
    },
  },
  // Plum: away from Chat violet and the AI cyan.
  appearance: {
    accent: "#8e1b6f",
    background: {
      from: "#8e1b6f",
      to: "#c4519f",
      angle: 135,
      strength: 14,
    },
  },
  basePath: "/app/assistant",
  baseUrl: "http://app-assistant:3000",
  skills: SKILLS,
  nav: {
    href: "/app/assistant",
    match: "/app/assistant",
    section: "primary",
    requiresAuth: true,
  },
  panel: { href: "/app/assistant/panel", label: "Gustav", icon: "ti ti-moustache", order: 0, code: true },
  pwa: { requiresRoles: ["user"], badge: "/api/assistant/pwa/badge", order: 1 },
  openapi: "/api/assistant/openapi.json",
  routes: ["/api/assistant", "/app/assistant", "/public/assistant"],
});

export const { ssr, plugin } = app;
