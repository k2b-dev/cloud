import { defineApp } from "@valentinkolb/cloud";
import { NOTIFICATIONS } from "./notifications";

export const app = defineApp({
  id: "accounts",
  name: "Accounts",
  icon: "ti ti-users-group",
  description: "Manage account access, groups, and account requests.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Konten",
        description: "Konten, Gruppen, Zugriffe und Kontoanfragen verwalten.",
      },
    },
  },
  appearance: { accent: "#4f46e5", background: { from: "#6366f1" } },
  basePath: "/app/accounts",
  baseUrl: "http://app-accounts:3000",
  notifications: NOTIFICATIONS,
  nav: {
    href: "/app/accounts",
    match: "/app/accounts",
    section: "more",
    requiresAuth: true,
    requiresRoles: ["user"],
  },
  widgets: [{ id: "admin-queue", path: "/api/accounts/widget/admin-queue" }],
  openapi: "/api/accounts/openapi.json",
  routes: ["/api/accounts", "/app/accounts", "/public/accounts"],
});

export const { ssr, plugin } = app;
