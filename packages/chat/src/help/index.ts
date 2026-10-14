import { defineHelp } from "@k2b/cloud/server";
import membersDe from "./documents/de/chat-members.help.md" with { type: "text" };
import sendDe from "./documents/de/chat-send.help.md" with { type: "text" };
import startDe from "./documents/de/chat-start.help.md" with { type: "text" };
import unreadDe from "./documents/de/chat-unread.help.md" with { type: "text" };
import members from "./documents/en/chat-members.help.md" with { type: "text" };
import send from "./documents/en/chat-send.help.md" with { type: "text" };
import start from "./documents/en/chat-start.help.md" with { type: "text" };
import unread from "./documents/en/chat-unread.help.md" with { type: "text" };

export const chatHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, send, unread, members],
    de: [startDe, sendDe, unreadDe, membersDe],
  },
});
