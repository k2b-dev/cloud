import { defineHelp } from "@valentinkolb/cloud/server";
import adminDe from "./documents/de/faq-admin.help.md" with { type: "text" };
import startDe from "./documents/de/faq-start.help.md" with { type: "text" };
import admin from "./documents/en/faq-admin.help.md" with { type: "text" };
import start from "./documents/en/faq-start.help.md" with { type: "text" };

export const faqHelp = defineHelp({
  baseLocale: "en",
  documents: { en: [start, admin], de: [startDe, adminDe] },
});
