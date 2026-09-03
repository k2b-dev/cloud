import { defineHelp } from "@valentinkolb/cloud/server";
import coreModelDe from "./documents/de/notebooks-core-model.help.md" with { type: "text" };
import settingsAccessDe from "./documents/de/notebooks-settings-access.help.md" with { type: "text" };
import startDe from "./documents/de/notebooks-start.help.md" with { type: "text" };
import structuredBlocksDe from "./documents/de/notebooks-structured-blocks.help.md" with { type: "text" };
import tableFormulasDe from "./documents/de/notebooks-table-formulas.help.md" with { type: "text" };
import troubleshootingDe from "./documents/de/notebooks-troubleshooting.help.md" with { type: "text" };
import writeOrganizeDe from "./documents/de/notebooks-write-organize.help.md" with { type: "text" };
import coreModel from "./documents/en/notebooks-core-model.help.md" with { type: "text" };
import settingsAccess from "./documents/en/notebooks-settings-access.help.md" with { type: "text" };
import start from "./documents/en/notebooks-start.help.md" with { type: "text" };
import structuredBlocks from "./documents/en/notebooks-structured-blocks.help.md" with { type: "text" };
import tableFormulas from "./documents/en/notebooks-table-formulas.help.md" with { type: "text" };
import troubleshooting from "./documents/en/notebooks-troubleshooting.help.md" with { type: "text" };
import writeOrganize from "./documents/en/notebooks-write-organize.help.md" with { type: "text" };

/** Explicit order keeps this corpus reviewable and independent of filesystem magic. */
export const notebookHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, coreModel, writeOrganize, structuredBlocks, tableFormulas, settingsAccess, troubleshooting],
    de: [startDe, coreModelDe, writeOrganizeDe, structuredBlocksDe, tableFormulasDe, settingsAccessDe, troubleshootingDe],
  },
});
