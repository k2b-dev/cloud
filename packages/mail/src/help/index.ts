import { defineHelp } from "@valentinkolb/cloud/server";
import adminDe from "./documents/de/mail-admin.help.md" with { type: "text" };
import automationDe from "./documents/de/mail-automation.help.md" with { type: "text" };
import collaborationDe from "./documents/de/mail-collaboration.help.md" with { type: "text" };
import composeDe from "./documents/de/mail-compose.help.md" with { type: "text" };
import securityDe from "./documents/de/mail-security.help.md" with { type: "text" };
import startDe from "./documents/de/mail-start.help.md" with { type: "text" };
import troubleshootingDe from "./documents/de/mail-troubleshooting.help.md" with { type: "text" };
import workDe from "./documents/de/mail-work.help.md" with { type: "text" };
import workflowsDe from "./documents/de/mail-workflows.help.md" with { type: "text" };
import admin from "./documents/en/mail-admin.help.md" with { type: "text" };
import automation from "./documents/en/mail-automation.help.md" with { type: "text" };
import collaboration from "./documents/en/mail-collaboration.help.md" with { type: "text" };
import compose from "./documents/en/mail-compose.help.md" with { type: "text" };
import security from "./documents/en/mail-security.help.md" with { type: "text" };
import start from "./documents/en/mail-start.help.md" with { type: "text" };
import troubleshooting from "./documents/en/mail-troubleshooting.help.md" with { type: "text" };
import work from "./documents/en/mail-work.help.md" with { type: "text" };
import workflows from "./documents/en/mail-workflows.help.md" with { type: "text" };

export const mailHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, work, compose, collaboration, security, admin, automation, workflows, troubleshooting],
    de: [startDe, workDe, composeDe, collaborationDe, securityDe, adminDe, automationDe, workflowsDe, troubleshootingDe],
  },
});
