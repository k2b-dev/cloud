import { defineHelp } from "@valentinkolb/cloud/server";
import startDe from "./documents/de/ipa-hosts-start.help.md" with { type: "text" };
import troubleshootDe from "./documents/de/ipa-hosts-troubleshooting.help.md" with { type: "text" };
import start from "./documents/en/ipa-hosts-start.help.md" with { type: "text" };
import troubleshoot from "./documents/en/ipa-hosts-troubleshooting.help.md" with { type: "text" };

export const ipaHostsHelp = defineHelp({
  baseLocale: "en",
  documents: { en: [start, troubleshoot], de: [startDe, troubleshootDe] },
});
