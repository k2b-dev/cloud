import { defineHelp } from "@valentinkolb/cloud/server";
import readDe from "./documents/de/weather-read.help.md" with { type: "text" };
import startDe from "./documents/de/weather-start.help.md" with { type: "text" };
import troubleshootDe from "./documents/de/weather-troubleshooting.help.md" with { type: "text" };
import read from "./documents/en/weather-read.help.md" with { type: "text" };
import start from "./documents/en/weather-start.help.md" with { type: "text" };
import troubleshoot from "./documents/en/weather-troubleshooting.help.md" with { type: "text" };

export const weatherHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, read, troubleshoot],
    de: [startDe, readDe, troubleshootDe],
  },
});
