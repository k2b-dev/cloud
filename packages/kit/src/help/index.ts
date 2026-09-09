import { defineHelp } from "@valentinkolb/cloud/server";
import en from "./documents/en/kit-start.help.md" with { type: "text" };
import de from "./documents/de/kit-start.help.md" with { type: "text" };
export const kitHelp = defineHelp({
  baseLocale: "en",
  documents: { en: [en], de: [de] },
});
