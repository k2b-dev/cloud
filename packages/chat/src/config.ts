import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "chat",
  name: "Chat",
  icon: "ti ti-messages",
  description: "Chats and channels for working together.",
  presentation: {
    baseLocale: "en",
    translations: { de: { description: "Chats und Kanäle für die Zusammenarbeit." } },
  },
  appearance: { accent: "#7c3aed", background: { from: "#8b5cf6", to: "#d946ef", angle: 135 } },
  basePath: "/app/chat",
  baseUrl: "http://app-chat:3000",
  adminHref: "/admin/chat",
  nav: {
    href: "/app/chat",
    match: "/app/chat",
    section: "primary",
    requiresAuth: true,
    requiresRoles: ["user", "guest"],
  },
  openapi: "/api/chat/openapi.json",
  routes: ["/api/chat", "/app/chat", "/admin/chat", "/public/chat"],
});

export const { ssr, plugin } = app;
