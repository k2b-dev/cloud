import { defineHelp } from "@k2b/cloud/server";
import cloudAppDe from "./documents/de/assistant-cloud-app.help.md" with { type: "text" };
import guidanceDe from "./documents/de/assistant-guidance.help.md" with { type: "text" };
import overviewDe from "./documents/de/assistant-overview.help.md" with { type: "text" };
import workflowDe from "./documents/de/assistant-workflow.help.md" with { type: "text" };
import cloudApp from "./documents/en/assistant-cloud-app.help.md" with { type: "text" };
import guidance from "./documents/en/assistant-guidance.help.md" with { type: "text" };
import overview from "./documents/en/assistant-overview.help.md" with { type: "text" };
import workflow from "./documents/en/assistant-workflow.help.md" with { type: "text" };

export const assistantHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [overview, workflow, guidance, cloudApp],
    de: [overviewDe, workflowDe, guidanceDe, cloudAppDe],
  },
});
