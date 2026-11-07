import { appAccess, defineApp } from "@k2b/cloud";
import { UNREAD_COUNT_PATH } from "./frontend/route";
import { NOTIFICATIONS } from "./notifications";
import { SKILLS } from "./skills";

export const app = defineApp({
  id: "chat",
  platformPermissions: ["resources:readers"],
  cli: { chat: { module: "src/cli.ts", references: "src/cli-references" } },
  // APIs admit roleless service accounts; navigation keeps its narrower audience.
  access: appAccess.signedIn({
    publicRoutes: ["/api/chat/openapi.json"],
  }),
  name: "Chat",
  icon: "ti ti-messages",
  description: "Chats and channels for working together.",
  presentation: {
    baseLocale: "en",
    translations: { de: { panelLabel: "Chat", description: "Chats und Kanäle für die Zusammenarbeit." } },
  },
  appearance: { accent: "#7c3aed", background: { from: "#8b5cf6", to: "#a855f7", angle: 135 } },
  basePath: "/app/chat",
  baseUrl: "http://app-chat:3000",
  adminHref: "/admin/chat",
  nav: {
    href: "/app/chat",
    match: "/app/chat",
    section: "primary",
    badge: "/api/chat/badge",
    requiresAuth: true,
    requiresRoles: ["user", "guest"],
  },
  // The badge is the notification count the rail, the phone bar and pushes show; the summary still says how many are unread.
  pwa: { requiresRoles: ["user"], badge: "/api/chat/badge", summary: UNREAD_COUNT_PATH, order: 2 },
  panel: { href: "/app/chat/panel", label: "Chat", icon: "ti ti-messages", requiresRoles: ["user", "guest"] },
  settings: {
    "chat.push_preview": {
      kind: "boolean",
      default: true,
      label: "Message text in notifications",
      description:
        "Shows the start of the message in push notifications, including on the lock screen. Off: shows only who writes in which chat. Applies to everyone.",
      presentation: {
        translations: {
          de: {
            label: "Nachrichtentext in Benachrichtigungen",
            description:
              "Zeigt den Anfang der Nachricht im Push, auch auf dem Sperrbildschirm. Aus: nur wer in welchem Chat schreibt. Gilt für alle.",
          },
        },
      },
    },
    "chat.discoverable_authenticated": {
      kind: "boolean",
      label: "Allow channels discoverable by all signed-in people",
      description:
        "Includes people and guests. Agents and service accounts need their own grant. Turning this off removes their discovery access; existing members keep access.",
      default: true,
      presentation: {
        translations: {
          de: {
            label: "Kanäle für alle Angemeldeten erlauben",
            description:
              "Schließt Personen und Gäste ein. Agenten und Dienstkonten brauchen ein eigenes Recht. Ausschalten entzieht den Zugriff über diese Auffindbarkeit; bestehende Mitglieder behalten Zugriff.",
          },
        },
      },
    },
  },
  notifications: NOTIFICATIONS,
  skills: SKILLS,
  openapi: "/api/chat/openapi.json",
  routes: ["/api/chat", "/app/chat", "/admin/chat", "/public/chat"],
});

export const { ssr, plugin } = app;
