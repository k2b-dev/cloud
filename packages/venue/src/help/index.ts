import { defineHelp } from "@k2b/cloud/server";
import startDe from "./documents/de/venue-start.help.md" with { type: "text" };
import troubleshootDe from "./documents/de/venue-troubleshooting.help.md" with { type: "text" };
import workDe from "./documents/de/venue-work.help.md" with { type: "text" };
import start from "./documents/en/venue-start.help.md" with { type: "text" };
import troubleshoot from "./documents/en/venue-troubleshooting.help.md" with { type: "text" };
import work from "./documents/en/venue-work.help.md" with { type: "text" };

export const venueHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, work, troubleshoot],
    de: [startDe, workDe, troubleshootDe],
  },
});
