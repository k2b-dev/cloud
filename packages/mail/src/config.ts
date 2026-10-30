import { appAccess, defineApp } from "@k2b/cloud";
import { MAIL_APP_ID, MAILBOX_RESOURCE_TYPE } from "./app-identity";
import { MAIL_CONTACT_DIRECTORY_SETTINGS } from "./contact-directory-settings";
import { appEnv } from "./env";
import { NOTIFICATIONS } from "./notifications";
import { SKILLS } from "./skills";

export { MAIL_APP_ID, MAILBOX_RESOURCE_TYPE };

export const app = defineApp({
  id: MAIL_APP_ID,
  // APIs admit roleless service accounts; navigation keeps its narrower audience.
  access: appAccess.signedIn({
    publicRoutes: ["/share/mail/attachments/:token", "/api/mail/openapi.json"],
  }),
  cli: { mail: { module: "src/cli.ts", references: "src/cli-references" } },
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
  skills: SKILLS,
  settings: {
    ...MAIL_CONTACT_DIRECTORY_SETTINGS,
    "mail.workflow_ai_body_max_chars": {
      kind: "number",
      default: 20000,
      label: "Workflow AI body limit (characters)",
      description:
        "Maximum body characters loaded for an AI step. Changes apply to new work; larger bodies fail visibly without truncation.",
      envVariable: "MAIL_WORKFLOW_AI_BODY_MAX_CHARS",
      envBootstrap: () => appEnv.$readPresent("MAIL_WORKFLOW_AI_BODY_MAX_CHARS"),
      integer: true,
      min: 1,
      max: 100000,
      presentation: {
        translations: {
          de: {
            label: "KI-Workflow-Textgrenze (Zeichen)",
            description:
              "Maximale Textlänge je KI-Schritt. Änderungen gelten für neue Arbeit; längere Texte werden sichtbar abgelehnt und nicht gekürzt.",
          },
        },
      },
    },
  },
  routes: ["/api/mail", "/app/mail", "/admin/mail", "/share/mail", "/public/mail"],
});

export const { ssr, plugin } = app;
