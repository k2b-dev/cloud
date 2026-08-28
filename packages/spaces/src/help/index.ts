import { defineHelp } from "@valentinkolb/cloud/server";
import sharingDe from "./documents/de/spaces-sharing.help.md" with { type: "text" };
import startDe from "./documents/de/spaces-start.help.md" with { type: "text" };
import troubleshootDe from "./documents/de/spaces-troubleshooting.help.md" with { type: "text" };
import viewsDe from "./documents/de/spaces-views.help.md" with { type: "text" };
import workflowDe from "./documents/de/spaces-workflow.help.md" with { type: "text" };
import sharing from "./documents/en/spaces-sharing.help.md" with { type: "text" };
import start from "./documents/en/spaces-start.help.md" with { type: "text" };
import troubleshoot from "./documents/en/spaces-troubleshooting.help.md" with { type: "text" };
import views from "./documents/en/spaces-views.help.md" with { type: "text" };
import workflow from "./documents/en/spaces-workflow.help.md" with { type: "text" };

export const spacesHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, views, workflow, sharing, troubleshoot],
    de: [startDe, viewsDe, workflowDe, sharingDe, troubleshootDe],
  },
});
