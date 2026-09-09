import { defineHelp } from "@k2b/cloud/server";
import setupDe from "./documents/de/proxy-auth-setup.help.md" with { type: "text" };
import startDe from "./documents/de/proxy-auth-start.help.md" with { type: "text" };
import troubleshootDe from "./documents/de/proxy-auth-troubleshooting.help.md" with { type: "text" };
import setup from "./documents/en/proxy-auth-setup.help.md" with { type: "text" };
import start from "./documents/en/proxy-auth-start.help.md" with { type: "text" };
import troubleshoot from "./documents/en/proxy-auth-troubleshooting.help.md" with { type: "text" };

export const proxyAuthHelp = defineHelp({
  baseLocale: "en",
  documents: { en: [start, setup, troubleshoot], de: [startDe, setupDe, troubleshootDe] },
});
