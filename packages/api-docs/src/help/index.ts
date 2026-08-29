import { defineHelp } from "@valentinkolb/cloud/server";
import startDe from "./documents/de/api-docs-start.help.md" with { type: "text" };
import start from "./documents/en/api-docs-start.help.md" with { type: "text" };

export const apiDocsHelp = defineHelp({
  baseLocale: "en",
  documents: { en: [start], de: [startDe] },
});
