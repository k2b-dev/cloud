import { skill } from "@k2b/cloud";
import assistantCodeModeAccess from "./skills/assistant-code-mode/references/access.md" with { type: "text" };
import assistantCodeModeAi from "./skills/assistant-code-mode/references/ai.md" with { type: "text" };
import assistantCodeModeAppActions from "./skills/assistant-code-mode/references/app-actions.md" with { type: "text" };
import assistantCodeModeApps from "./skills/assistant-code-mode/references/apps.md" with { type: "text" };
import assistantCodeModeCamt from "./skills/assistant-code-mode/references/camt.md" with { type: "text" };
import assistantCodeModeCapabilities from "./skills/assistant-code-mode/references/capabilities.md" with { type: "text" };
import assistantCodeModeCharts from "./skills/assistant-code-mode/references/charts.md" with { type: "text" };
import assistantCodeModeChat from "./skills/assistant-code-mode/references/chat.md" with { type: "text" };
import assistantCodeModeCloud from "./skills/assistant-code-mode/references/cloud.md" with { type: "text" };
import assistantCodeModeDatabase from "./skills/assistant-code-mode/references/database.md" with { type: "text" };
import assistantCodeModeDebugging from "./skills/assistant-code-mode/references/debugging.md" with { type: "text" };
import assistantCodeModeDocuments from "./skills/assistant-code-mode/references/documents.md" with { type: "text" };
import assistantCodeModeEinvoice from "./skills/assistant-code-mode/references/einvoice.md" with { type: "text" };
import assistantCodeModeExamples from "./skills/assistant-code-mode/references/examples.md" with { type: "text" };
import assistantCodeModeFiles from "./skills/assistant-code-mode/references/files.md" with { type: "text" };
import assistantCodeModeFinance from "./skills/assistant-code-mode/references/finance.md" with { type: "text" };
import assistantCodeModeHttp from "./skills/assistant-code-mode/references/http.md" with { type: "text" };
import assistantCodeModeInvestigation from "./skills/assistant-code-mode/references/investigation.md" with { type: "text" };
import assistantCodeModeManagement from "./skills/assistant-code-mode/references/management.md" with { type: "text" };
import assistantCodeModeMoney from "./skills/assistant-code-mode/references/money.md" with { type: "text" };
import assistantCodeModePdf from "./skills/assistant-code-mode/references/pdf.md" with { type: "text" };
import assistantCodeModePublishing from "./skills/assistant-code-mode/references/publishing.md" with { type: "text" };
import assistantCodeModeRuntime from "./skills/assistant-code-mode/references/runtime.md" with { type: "text" };
import assistantCodeModeSourceWorkflow from "./skills/assistant-code-mode/references/source-workflow.md" with { type: "text" };
import assistantCodeModeStorage from "./skills/assistant-code-mode/references/storage.md" with { type: "text" };
import assistantCodeMode from "./skills/assistant-code-mode/SKILL.md" with { type: "text" };
import assistantDataAnalysis from "./skills/assistant-data-analysis/SKILL.md" with { type: "text" };
import cloudAssistant from "./skills/cloud-assistant/SKILL.md" with { type: "text" };
import scheduledTasks from "./skills/scheduled-tasks/SKILL.md" with { type: "text" };
import skillCreator from "./skills/skill-creator/SKILL.md" with { type: "text" };

/** Assistant Skills this app ships; Cloud installs and updates them from these files. */
export const SKILLS = [
  skill({
    markdown: assistantCodeMode,
    references: {
      "references/access.md": assistantCodeModeAccess,
      "references/ai.md": assistantCodeModeAi,
      "references/app-actions.md": assistantCodeModeAppActions,
      "references/apps.md": assistantCodeModeApps,
      "references/camt.md": assistantCodeModeCamt,
      "references/capabilities.md": assistantCodeModeCapabilities,
      "references/charts.md": assistantCodeModeCharts,
      "references/chat.md": assistantCodeModeChat,
      "references/cloud.md": assistantCodeModeCloud,
      "references/database.md": assistantCodeModeDatabase,
      "references/debugging.md": assistantCodeModeDebugging,
      "references/documents.md": assistantCodeModeDocuments,
      "references/einvoice.md": assistantCodeModeEinvoice,
      "references/examples.md": assistantCodeModeExamples,
      "references/files.md": assistantCodeModeFiles,
      "references/finance.md": assistantCodeModeFinance,
      "references/http.md": assistantCodeModeHttp,
      "references/investigation.md": assistantCodeModeInvestigation,
      "references/management.md": assistantCodeModeManagement,
      "references/money.md": assistantCodeModeMoney,
      "references/pdf.md": assistantCodeModePdf,
      "references/publishing.md": assistantCodeModePublishing,
      "references/runtime.md": assistantCodeModeRuntime,
      "references/source-workflow.md": assistantCodeModeSourceWorkflow,
      "references/storage.md": assistantCodeModeStorage,
    },
  }),
  skill({ markdown: assistantDataAnalysis }),
  skill({ markdown: cloudAssistant }),
  skill({ markdown: scheduledTasks }),
  skill({ markdown: skillCreator }),
];
