import { appAccess, defineApp } from "@k2b/cloud";
import { MAIL_APP_ID, MAILBOX_RESOURCE_TYPE } from "./app-identity";
import { MAIL_CONTACT_DIRECTORY_SETTINGS } from "./contact-directory-settings";
import { appEnv } from "./env";
import { NOTIFICATIONS } from "./notifications";
import { SKILLS } from "./skills";

export { MAIL_APP_ID, MAILBOX_RESOURCE_TYPE };

export const app = defineApp({
  id: MAIL_APP_ID,
  // A public attachment link and its password grant never use Cloud session authority.
  sessionlessRoutes: ["/share/mail/attachments/:token"],
  // Resource-bound and roleless service accounts remain eligible.
  access: appAccess.noGuests({
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
      label: "Summary AI body limit (characters)",
      description: "Maximum message body characters loaded for a summary. Changes apply to new summaries.",
      envVariable: "MAIL_WORKFLOW_AI_BODY_MAX_CHARS",
      envBootstrap: () => appEnv.$readPresent("MAIL_WORKFLOW_AI_BODY_MAX_CHARS"),
      integer: true,
      min: 1,
      max: 100000,
      presentation: {
        translations: {
          de: {
            label: "KI-Textgrenze für Zusammenfassungen (Zeichen)",
            description: "Maximale Nachrichtenlänge für eine Zusammenfassung. Änderungen gelten für neue Zusammenfassungen.",
          },
        },
      },
    },
  },
  routes: ["/api/mail", "/app/mail", "/admin/mail", "/share/mail", "/public/mail"],
});

export const { ssr, plugin } = app;
