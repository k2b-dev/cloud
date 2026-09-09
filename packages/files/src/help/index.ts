import { defineHelp } from "@k2b/cloud/server";
import startDe from "./documents/de/files-start.help.md" with { type: "text" };
import troubleshootDe from "./documents/de/files-troubleshooting.help.md" with { type: "text" };
import workDe from "./documents/de/files-work.help.md" with { type: "text" };
import start from "./documents/en/files-start.help.md" with { type: "text" };
import troubleshoot from "./documents/en/files-troubleshooting.help.md" with { type: "text" };
import work from "./documents/en/files-work.help.md" with { type: "text" };

export const filesHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, work, troubleshoot],
    de: [startDe, workDe, troubleshootDe],
  },
});
