import { defineHelp } from "@k2b/cloud/server";
import adminDe from "./documents/de/filesv2-admin.help.md" with { type: "text" };
import startDe from "./documents/de/filesv2-start.help.md" with { type: "text" };
import adminEn from "./documents/en/filesv2-admin.help.md" with { type: "text" };
import startEn from "./documents/en/filesv2-start.help.md" with { type: "text" };

export const filesHelp = defineHelp({ baseLocale: "en", documents: { en: [startEn, adminEn], de: [startDe, adminDe] } });
