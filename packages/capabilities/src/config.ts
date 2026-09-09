import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "capabilities",
  name: "Capabilities",
  icon: "ti ti-api-app",
  description: "Inspect and run the live Queries and Actions available to your account.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Capabilities",
        description: "Die für das eigene Konto verfügbaren Queries und Actions prüfen und ausführen.",
      },
    },
  },
  appearance: {
    accent: "#4f46e5",
    background: {
      from: "#6366f1",
      via: "#ffffff",
      to: "#22d3ee",
      angle: 135,
      strength: 12,
    },
  },
  basePath: "/app/capabilities",
  baseUrl: "http://app-capabilities:3000",
  nav: {
    href: "/app/capabilities",
    match: "/app/capabilities",
    section: "more",
    requiresAuth: true,
  },
  routes: ["/app/capabilities", "/public/capabilities"],
});

export const { ssr, plugin } = app;
