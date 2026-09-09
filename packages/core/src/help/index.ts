import { defineHelp } from "@k2b/cloud/server";
import adminDe from "./documents/de/core-admin.help.md" with { type: "text" };
import notificationsDe from "./documents/de/core-notifications.help.md" with { type: "text" };
import profileDe from "./documents/de/core-profile.help.md" with { type: "text" };
import securityDe from "./documents/de/core-security.help.md" with { type: "text" };
import startDe from "./documents/de/core-start.help.md" with { type: "text" };
import admin from "./documents/en/core-admin.help.md" with { type: "text" };
import notifications from "./documents/en/core-notifications.help.md" with { type: "text" };
import profile from "./documents/en/core-profile.help.md" with { type: "text" };
import security from "./documents/en/core-security.help.md" with { type: "text" };
import start from "./documents/en/core-start.help.md" with { type: "text" };

export const coreHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, profile, security, notifications, admin],
    de: [startDe, profileDe, securityDe, notificationsDe, adminDe],
  },
});
