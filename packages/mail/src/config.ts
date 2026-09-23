import { defineApp } from "@k2b/cloud";
import { MAIL_APP_ID, MAILBOX_RESOURCE_TYPE } from "./app-identity";
import { MAIL_CONTACT_DIRECTORY_SETTINGS } from "./contact-directory-settings";
import { NOTIFICATIONS } from "./notifications";

export { MAIL_APP_ID, MAILBOX_RESOURCE_TYPE };

export const app = defineApp({
  id: MAIL_APP_ID,
  name: "Mail",
  icon: "ti ti-mail",
  description: "Read, search, organize, draft, and send email collaboratively.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Mail",
        description: "E-Mails gemeinsam lesen, durchsuchen, organisieren, verfassen und senden.",
      },
    },
  },
  appearance: { accent: "#0f766e", background: { from: "#0f766e", to: "#2563eb", angle: 135 } },
  basePath: "/app/mail",
  baseUrl: "http://app-mail:3000",
  adminHref: "/admin/mail",
  nav: {
    href: "/app/mail",
    match: "/app/mail",
    section: "primary",
    requiresAuth: true,
    requiresRoles: ["user"],
  },
  openapi: "/api/mail/openapi.json",
  notifications: NOTIFICATIONS,
  settings: MAIL_CONTACT_DIRECTORY_SETTINGS,
  routes: ["/api/mail", "/app/mail", "/admin/mail", "/share/mail", "/public/mail"],
});

export const { ssr, plugin } = app;
