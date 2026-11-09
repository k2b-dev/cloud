import { skill } from "@k2b/cloud";
import assistantCodeModeAi from "./skills/assistant-code-mode/references/ai.md" with { type: "text" };
import assistantCodeModeCamt from "./skills/assistant-code-mode/references/camt.md" with { type: "text" };
import assistantCodeModeCapabilities from "./skills/assistant-code-mode/references/capabilities.md" with { type: "text" };
import assistantCodeModeChartKinds from "./skills/assistant-code-mode/references/chart-kinds.md" with { type: "text" };
import assistantCodeModeCharts from "./skills/assistant-code-mode/references/charts.md" with { type: "text" };
import assistantCodeModeCloud from "./skills/assistant-code-mode/references/cloud.md" with { type: "text" };
import assistantCodeModeDebugging from "./skills/assistant-code-mode/references/debugging.md" with { type: "text" };
import assistantCodeModeDocuments from "./skills/assistant-code-mode/references/documents.md" with { type: "text" };
import assistantCodeModeEinvoice from "./skills/assistant-code-mode/references/einvoice.md" with { type: "text" };
import assistantCodeModeExamples from "./skills/assistant-code-mode/references/examples.md" with { type: "text" };
import assistantCodeModeFiles from "./skills/assistant-code-mode/references/files.md" with { type: "text" };
import assistantCodeModeFinance from "./skills/assistant-code-mode/references/finance.md" with { type: "text" };
import assistantCodeModeHttp from "./skills/assistant-code-mode/references/http.md" with { type: "text" };
import assistantCodeModeInvestigation from "./skills/assistant-code-mode/references/investigation.md" with { type: "text" };
import assistantCodeModeMoney from "./skills/assistant-code-mode/references/money.md" with { type: "text" };
import assistantCodeModePdf from "./skills/assistant-code-mode/references/pdf.md" with { type: "text" };
import assistantCodeModeRuntime from "./skills/assistant-code-mode/references/runtime.md" with { type: "text" };
import assistantCodeModeViews from "./skills/assistant-code-mode/references/views.md" with { type: "text" };
import assistantCodeMode from "./skills/assistant-code-mode/SKILL.md" with { type: "text" };
import assistantDataAnalysis from "./skills/assistant-data-analysis/SKILL.md" with { type: "text" };
import cloudAssistant from "./skills/cloud-assistant/SKILL.md" with { type: "text" };
import codeAuthoringAccess from "./skills/code-authoring/references/access.md" with { type: "text" };
import codeAuthoringAi from "./skills/code-authoring/references/ai.md" with { type: "text" };
import codeAuthoringCapabilities from "./skills/code-authoring/references/capabilities.md" with { type: "text" };
import codeAuthoringData from "./skills/code-authoring/references/data.md" with { type: "text" };
import codeAuthoringEvents from "./skills/code-authoring/references/events.md" with { type: "text" };
import codeAuthoringFileRef from "./skills/code-authoring/references/file-ref.md" with { type: "text" };
import codeAuthoringPages from "./skills/code-authoring/references/pages.md" with { type: "text" };
import codeAuthoringRebuild from "./skills/code-authoring/references/rebuild.md" with { type: "text" };
import codeAuthoringSchedules from "./skills/code-authoring/references/schedules.md" with { type: "text" };
import codeAuthoringTesting from "./skills/code-authoring/references/testing.md" with { type: "text" };
import codeAuthoringTroubleshooting from "./skills/code-authoring/references/troubleshooting.md" with { type: "text" };
import codeAuthoring from "./skills/code-authoring/SKILL.md" with { type: "text" };
import codeAuthoringTemplateDashboardPage from "./skills/code-authoring/templates/dashboard-page.md" with { type: "text" };
import codeAuthoringTemplateEventToChat from "./skills/code-authoring/templates/event-to-chat.md" with { type: "text" };
import codeAuthoringTemplateFormApp from "./skills/code-authoring/templates/form-app.md" with { type: "text" };
import codeAuthoringTemplateMailAutomation from "./skills/code-authoring/templates/mail-automation.md" with { type: "text" };
import codeAuthoringTemplateMailInvoices from "./skills/code-authoring/templates/mail-invoices.md" with { type: "text" };
import codeAuthoringTemplateSurvey from "./skills/code-authoring/templates/survey.md" with { type: "text" };
import codeAuthoringTemplateTaskDueTomorrow from "./skills/code-authoring/templates/task-due-tomorrow.md" with { type: "text" };
import codeAuthoringTemplateWeeklyReport from "./skills/code-authoring/templates/weekly-report.md" with { type: "text" };
import skillCreator from "./skills/skill-creator/SKILL.md" with { type: "text" };

/** Assistant Skills this app ships; Cloud installs and updates them from these files. */
export const SKILLS = [
  skill({
    markdown: codeAuthoring,
    references: {
      "references/access.md": codeAuthoringAccess,
      "references/ai.md": codeAuthoringAi,
      "references/capabilities.md": codeAuthoringCapabilities,
      "references/data.md": codeAuthoringData,
      "references/events.md": codeAuthoringEvents,
      "references/file-ref.md": codeAuthoringFileRef,
      "references/pages.md": codeAuthoringPages,
      "references/rebuild.md": codeAuthoringRebuild,
      "references/schedules.md": codeAuthoringSchedules,
      "references/testing.md": codeAuthoringTesting,
      "references/troubleshooting.md": codeAuthoringTroubleshooting,
      "references/template-dashboard-page.md": codeAuthoringTemplateDashboardPage,
      "references/template-event-to-chat.md": codeAuthoringTemplateEventToChat,
      "references/template-form-app.md": codeAuthoringTemplateFormApp,
      "references/template-mail-automation.md": codeAuthoringTemplateMailAutomation,
      "references/template-mail-invoices.md": codeAuthoringTemplateMailInvoices,
      "references/template-task-due-tomorrow.md": codeAuthoringTemplateTaskDueTomorrow,
      "references/template-survey.md": codeAuthoringTemplateSurvey,
      "references/template-weekly-report.md": codeAuthoringTemplateWeeklyReport,
    },
  }),
  skill({
    markdown: assistantCodeMode,
    references: {
      "references/views.md": assistantCodeModeViews,
      "references/ai.md": assistantCodeModeAi,
      "references/camt.md": assistantCodeModeCamt,
      "references/capabilities.md": assistantCodeModeCapabilities,
      "references/charts.md": assistantCodeModeCharts,
      "references/chart-kinds.md": assistantCodeModeChartKinds,
      "references/cloud.md": assistantCodeModeCloud,
      "references/debugging.md": assistantCodeModeDebugging,
      "references/documents.md": assistantCodeModeDocuments,
      "references/einvoice.md": assistantCodeModeEinvoice,
      "references/examples.md": assistantCodeModeExamples,
      "references/files.md": assistantCodeModeFiles,
      "references/finance.md": assistantCodeModeFinance,
      "references/http.md": assistantCodeModeHttp,
      "references/investigation.md": assistantCodeModeInvestigation,
      "references/money.md": assistantCodeModeMoney,
      "references/pdf.md": assistantCodeModePdf,
      "references/runtime.md": assistantCodeModeRuntime,
    },
  }),
  skill({ markdown: assistantDataAnalysis }),
  skill({ markdown: cloudAssistant }),
  skill({ markdown: skillCreator }),
];
