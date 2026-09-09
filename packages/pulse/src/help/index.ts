import { defineHelp } from "@k2b/cloud/server";
import dashboardDslDe from "./documents/de/pulse-dashboard-dsl.help.md" with { type: "text" };
import dataModelDe from "./documents/de/pulse-data-model.help.md" with { type: "text" };
import findDataDe from "./documents/de/pulse-find-data.help.md" with { type: "text" };
import operateDe from "./documents/de/pulse-operate.help.md" with { type: "text" };
import queryDslDe from "./documents/de/pulse-query-dsl.help.md" with { type: "text" };
import referenceDe from "./documents/de/pulse-reference.help.md" with { type: "text" };
import startDe from "./documents/de/pulse-start.help.md" with { type: "text" };
import dashboardDsl from "./documents/en/pulse-dashboard-dsl.help.md" with { type: "text" };
import dataModel from "./documents/en/pulse-data-model.help.md" with { type: "text" };
import findData from "./documents/en/pulse-find-data.help.md" with { type: "text" };
import operate from "./documents/en/pulse-operate.help.md" with { type: "text" };
import queryDsl from "./documents/en/pulse-query-dsl.help.md" with { type: "text" };
import reference from "./documents/en/pulse-reference.help.md" with { type: "text" };
import start from "./documents/en/pulse-start.help.md" with { type: "text" };

export const pulseHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, dataModel, findData, queryDsl, dashboardDsl, reference, operate],
    de: [startDe, dataModelDe, findDataDe, queryDslDe, dashboardDslDe, referenceDe, operateDe],
  },
});
