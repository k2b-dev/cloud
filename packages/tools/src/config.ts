import { defineApp } from "@valentinkolb/cloud";

export const app = defineApp({
  id: "tools",
  name: "Tools",
  icon: "ti ti-tools",
  description: "Utility tools for day-to-day work tasks.",
  appearance: { accent: "#475569", background: { from: "#64748b" } },
  presentation: {
    baseLocale: "en",
    translations: {
      de: { name: "Werkzeuge", description: "Praktische Werkzeuge für alltägliche Aufgaben." },
    },
  },
  basePath: "/tools",
  baseUrl: "http://app-tools:3000",
  nav: {
    href: "/tools",
    match: "/tools",
    section: "more",
  },
  openapi: "/tools/api/openapi.json",
  // Top-level `/tools` (no `/app/tools` for the legacy short URL).
  routes: ["/tools", "/public/tools"],
});

export const { ssr, plugin } = app;
