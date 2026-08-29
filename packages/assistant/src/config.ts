import { defineApp } from "@valentinkolb/cloud";

export const app = defineApp({
  id: "assistant",
  name: "Assistant",
  icon: "ti ti-sparkles",
  description: "General-purpose AI assistant for writing, rewriting, summarizing, and questions.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Assistent",
        description: "KI-Assistent zum Schreiben, Überarbeiten, Zusammenfassen und Beantworten von Fragen.",
      },
    },
  },
  appearance: {
    accent: "#14b8a6",
    background: {
      from: "#14b8a6",
      to: "#3b82f6",
      angle: 135,
    },
  },
  basePath: "/app/assistant",
  baseUrl: "http://app-assistant:3000",
  nav: {
    href: "/app/assistant",
    match: "/app/assistant",
    section: "primary",
    requiresAuth: true,
  },
  openapi: "/api/assistant/openapi.json",
  routes: ["/api/assistant", "/app/assistant", "/public/assistant"],
});

export const { ssr, plugin } = app;
