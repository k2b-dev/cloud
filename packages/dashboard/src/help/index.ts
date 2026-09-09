import { defineHelp } from "@k2b/cloud/server";
import startDe from "./documents/de/dashboard-start.help.md" with { type: "text" };
import troubleshootDe from "./documents/de/dashboard-troubleshooting.help.md" with { type: "text" };
import start from "./documents/en/dashboard-start.help.md" with { type: "text" };
import troubleshoot from "./documents/en/dashboard-troubleshooting.help.md" with { type: "text" };

export const dashboardHelp = defineHelp({
  baseLocale: "en",
  documents: { en: [start, troubleshoot], de: [startDe, troubleshootDe] },
});
