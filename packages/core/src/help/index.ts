import { defineHelp } from "@valentinkolb/cloud/server";
import admin from "./documents/core-admin.help.md" with { type: "text" };
import notifications from "./documents/core-notifications.help.md" with { type: "text" };
import profile from "./documents/core-profile.help.md" with { type: "text" };
import security from "./documents/core-security.help.md" with { type: "text" };
import start from "./documents/core-start.help.md" with { type: "text" };
import notificationsDe from "./documents/de/core-notifications.help.md" with { type: "text" };
import profileDe from "./documents/de/core-profile.help.md" with { type: "text" };
import securityDe from "./documents/de/core-security.help.md" with { type: "text" };

export const coreHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, profile, security, notifications, admin],
    de: [profileDe, securityDe, notificationsDe],
  },
});
