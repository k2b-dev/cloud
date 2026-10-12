import { defineHelp } from "@k2b/cloud/server";
import sendDe from "./documents/de/chat-send.help.md" with { type: "text" };
import startDe from "./documents/de/chat-start.help.md" with { type: "text" };
import send from "./documents/en/chat-send.help.md" with { type: "text" };
import start from "./documents/en/chat-start.help.md" with { type: "text" };

export const chatHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, send],
    de: [startDe, sendDe],
  },
});
