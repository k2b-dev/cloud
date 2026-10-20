import { defineHelp } from "@k2b/cloud/server";
import dataModelDe from "./documents/de/pulse-data-model.help.md" with { type: "text" };
import operateDe from "./documents/de/pulse-operate.help.md" with { type: "text" };
import startDe from "./documents/de/pulse-start.help.md" with { type: "text" };
import dataModel from "./documents/en/pulse-data-model.help.md" with { type: "text" };
import operate from "./documents/en/pulse-operate.help.md" with { type: "text" };
import start from "./documents/en/pulse-start.help.md" with { type: "text" };

export const pulseHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, dataModel, operate],
    de: [startDe, dataModelDe, operateDe],
  },
});
