import { defineHelp } from "@k2b/cloud/server";
import startDe from "./documents/de/chat-start.help.md" with { type: "text" };
import start from "./documents/en/chat-start.help.md" with { type: "text" };

export const chatHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start],
    de: [startDe],
  },
});
