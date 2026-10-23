import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "chat",
  name: "Chat",
  icon: "ti ti-messages",
  description: "Chats and channels for working together.",
  presentation: {
    baseLocale: "en",
    translations: { de: { panelLabel: "Chat", description: "Chats und Kanäle für die Zusammenarbeit." } },
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
  panel: { href: "/app/chat/panel", label: "Chat", icon: "ti ti-messages", requiresRoles: ["user", "guest"] },
  settings: {
    "chat.discoverable_authenticated": {
      kind: "boolean",
      label: "Allow channels discoverable by all signed-in accounts",
      description: "Includes guests and service accounts. Turning this off removes their discovery access; existing members keep access.",
      default: true,
      presentation: {
        translations: {
          de: {
            label: "Kanäle für alle Angemeldeten erlauben",
            description:
              "Schließt Gäste und Dienstkonten ein. Ausschalten entzieht den Zugriff über diese Auffindbarkeit; bestehende Mitglieder behalten Zugriff.",
          },
        },
      },
    },
  },
  openapi: "/api/chat/openapi.json",
  routes: ["/api/chat", "/app/chat", "/admin/chat", "/public/chat"],
});

export const { ssr, plugin } = app;
