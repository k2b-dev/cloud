import { defineHelp } from "@valentinkolb/cloud/server";
import { sdkHelp } from "./sdk";
import en0 from "./documents/en/kit-start.help.md" with { type: "text" };
import en1 from "./documents/en/kit-authoring.help.md" with { type: "text" };
import en2 from "./documents/en/kit-assistant.help.md" with { type: "text" };
import en3 from "./documents/en/kit-sharing.help.md" with { type: "text" };
import de0 from "./documents/de/kit-start.help.md" with { type: "text" };
import de1 from "./documents/de/kit-authoring.help.md" with { type: "text" };
import de2 from "./documents/de/kit-assistant.help.md" with { type: "text" };
import de3 from "./documents/de/kit-sharing.help.md" with { type: "text" };
export const kitHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [en0, en1, en2, en3, ...sdkHelp("en")],
    de: [de0, de1, de2, de3, ...sdkHelp("de")],
  },
});
