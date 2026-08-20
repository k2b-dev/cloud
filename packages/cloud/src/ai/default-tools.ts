import {
  CloudAiCardInputSchema,
  CloudAiCardOutputSchema,
  CloudAiLocalBashInputSchema,
  CloudAiLocalBashOutputSchema,
  CloudAiSurveyInputSchema,
  CloudAiSurveyOutputSchema,
  CloudAiTextEditorInputSchema,
  CloudAiTextEditorOutputSchema,
} from "./default-tool-contracts";
import {
  createCloudAiCalculateTool,
  createCloudAiListFilesTool,
  createCloudAiPresentTool,
  createCloudAiReadFileTool,
  createCloudAiWriteFileTool,
} from "./file-tools";
import { createCloudAiWebExtractTool, createCloudAiWebSearchTool, isCloudAiFirecrawlConfigured } from "./firecrawl-tools";
import { createCloudAiMarkdownToPdfTool } from "./markdown-pdf-tool";
import { defineAiTool } from "./tools";
import type { AiDataBoundary, AiRuntimeTool } from "./types";
import { createCloudAiViewImageTool } from "./vision-tool";

export {
  type CloudAiCardInput,
  CloudAiCardInputSchema,
  type CloudAiCardOutput,
  CloudAiCardOutputSchema,
  type CloudAiLocalBashInput,
  CloudAiLocalBashInputSchema,
  type CloudAiLocalBashOutput,
  CloudAiLocalBashOutputSchema,
  type CloudAiSurveyInput,
  CloudAiSurveyInputSchema,
  type CloudAiSurveyOutput,
  CloudAiSurveyOutputSchema,
  type CloudAiTextEditorInput,
  CloudAiTextEditorInputSchema,
  type CloudAiTextEditorOutput,
  CloudAiTextEditorOutputSchema,
} from "./default-tool-contracts";

export const createCloudAiCardTool = () =>
  defineAiTool({
    name: "card",
    description:
      "Render one compact visual highlight card in the chat. Use it only for a single status, metric, KPI, or short result. Use normal markdown for tables, lists, comparisons, and longer explanations. Keep all fields flat; do not pass arrays or nested objects.",
    inputSchema: CloudAiCardInputSchema,
    outputSchema: CloudAiCardOutputSchema,
    approval: "never",
    promptHint: "show one compact highlight card (metric, KPI, status) — not for tables, lists, or long text.",
  }).clientView();

export const createCloudAiSurveyTool = () =>
  defineAiTool({
    name: "survey",
    description:
      "Ask the user for structured input inside the chat. Use only when the conversation needs explicit choices, ratings, or short form answers.",
    inputSchema: CloudAiSurveyInputSchema,
    outputSchema: CloudAiSurveyOutputSchema,
    approval: "never",
    promptHint: "collect explicit choices, ratings, or short structured answers from the user — instead of writing option lists in text.",
  }).clientInteraction();

export const createCloudAiTextEditorTool = () =>
  defineAiTool({
    name: "text_editor",
    description:
      "Let the user review one substantial plain-text or Markdown draft inside the chat. Provide the complete proposed content. The user can edit and accept the draft or return feedback instead. When feedback is returned, revise the original draft and present the complete replacement with text_editor again. Use this for mail bodies, letters, notes, or other long-form text that the user should review before the assistant continues. This does not save or send anything.",
    inputSchema: CloudAiTextEditorInputSchema,
    outputSchema: CloudAiTextEditorOutputSchema,
    approval: "never",
    promptHint:
      "let the user review a substantial text draft before continuing; if they request changes, revise it and present the complete replacement with text_editor again — not for short answers or read-only final responses.",
  }).clientInteraction();

export const createCloudAiLocalBashTool = () =>
  defineAiTool({
    name: "local_bash",
    description:
      "Run one Bash command on the user's local CLI computer after the CLI shows the exact command and the user confirms it. Use only when local computer interaction is necessary. The command runs from the CLI's startup directory as the current OS user. Inspect the returned status, exit code, stdout, and stderr before continuing.",
    inputSchema: CloudAiLocalBashInputSchema,
    outputSchema: CloudAiLocalBashOutputSchema,
    approval: "never",
    promptHint:
      "use local_bash only when work on the user's local CLI computer is necessary; every command requires local confirmation and its result must be checked.",
  }).client();

export const createDefaultCloudAiTools = () => [createCloudAiSurveyTool(), createCloudAiTextEditorTool()];

/** Built-ins advertised through discovery and loaded only when needed. */
export const CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES = new Set([
  "survey",
  "text_editor",
  "list_files",
  "write_file",
  "markdown_to_pdf",
  "present",
  "calculate",
  "read_cloud_resource",
]);

export const createConfiguredDefaultCloudAiTools = async (config?: {
  firecrawlApiKey?: string | null;
  fetch?: typeof fetch;
  allowedDataBoundaries?: AiDataBoundary[];
}) => {
  const tools: AiRuntimeTool[] = [
    ...createDefaultCloudAiTools(),
    createCloudAiListFilesTool(),
    createCloudAiReadFileTool(),
    createCloudAiWriteFileTool(),
    createCloudAiMarkdownToPdfTool(),
    createCloudAiPresentTool(),
    createCloudAiCalculateTool(),
    createCloudAiViewImageTool(),
  ];
  const firecrawlConfigured =
    config && "firecrawlApiKey" in config ? Boolean(config.firecrawlApiKey?.trim()) : await isCloudAiFirecrawlConfigured();
  if (firecrawlConfigured) {
    tools.push(createCloudAiWebSearchTool({ apiKey: config?.firecrawlApiKey, fetch: config?.fetch }));
    tools.push(createCloudAiWebExtractTool({ apiKey: config?.firecrawlApiKey, fetch: config?.fetch }));
  }
  return tools;
};
