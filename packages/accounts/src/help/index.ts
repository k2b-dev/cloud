import { defineHelp } from "@k2b/cloud/server";
import adminDe from "./documents/de/accounts-admin.help.md" with { type: "text" };
import cliDe from "./documents/de/accounts-cli.help.md" with { type: "text" };
import lifecycleDe from "./documents/de/accounts-lifecycle.help.md" with { type: "text" };
import startDe from "./documents/de/accounts-start.help.md" with { type: "text" };
import admin from "./documents/en/accounts-admin.help.md" with { type: "text" };
import cli from "./documents/en/accounts-cli.help.md" with { type: "text" };
import lifecycle from "./documents/en/accounts-lifecycle.help.md" with { type: "text" };
import start from "./documents/en/accounts-start.help.md" with { type: "text" };

export const accountsHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, admin, lifecycle, cli],
    de: [startDe, adminDe, lifecycleDe, cliDe],
  },
});
