import { CODE_SOURCE_TOOLS } from "./code-source-contracts";
import { createCodeSourceTools } from "./code-source-tools";
import { CODE_RUNTIME_TOOL_NAMES, CodeRunInput, CodeInspectInput, CodeInteractInput, CodeStopInput, CodeOpenInput, CodeExportInput, CodeSecretInput } from "./browser-code-contracts";
import { z } from "zod";
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
import { createCloudAiFetchFileTool } from "./fetch-file-tool";
import { createCloudAiWebExtractTool, createCloudAiWebSearchTool, isCloudAiFirecrawlConfigured } from "./firecrawl-tools";
import { createCloudAiMarkdownToPdfTool } from "./markdown-pdf-tool";
import { defineAiTool } from "./tools";
import type { AiDataBoundary, AiRuntimeTool } from "./types";
import { createCloudAiTranscribeAudioTool } from "./audio-tool";
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

export const createCloudAiCodeTools = () => [
  defineAiTool({name:"code_secret",description:"Open a trusted Secret input dialog. The user enters the value directly into encrypted Assistant storage; only configured/name returns. Never ask for a credential in chat, survey, app controls or code_interact. Personal secrets are scoped to this chat or resource and bound to the exact HTTPS origin, header and prefix. Use secret(name,{prefix}) in http.fetch headers; load assistant-code-mode for HTTP details. Web UI required for secret entry; stored secrets also work from CLI.",inputSchema:CodeSecretInput,outputSchema:z.object({configured:z.boolean(),name:z.string()}),approval:"never"}).client(),
  defineAiTool({ name: "code_run", promptHint: "For file analysis, data transformations or combining Cloud data, run a short one-off script with code_run. Load assistant-code-mode for its runtime APIs; no saved app is required.", description: "Run a saved resource id OR one-off code in the isolated worker. Optional resourceId binds one-off code to existing app data (Manage required), without editing its source. Includes capabilities.run(name,input) to chain Cloud capabilities in JavaScript; load assistant-code-mode for its runtime APIs. Scripts accept current chat inputPaths; app test runs use them only as explicit picker fixtures. Returns output, logs and UI state. Local test storage is temporary; shared data, database writes and capability effects are real and keep normal permissions and approvals.", inputSchema: CodeRunInput, outputSchema: z.json(), approval: "never" }).client(),
  defineAiTool({ name: "code_inspect", description: "Inspect a test run: errors, logs, output, controls and pending modal. Use nodeId to inspect table rows or list items; follow pagination only as needed.", inputSchema: CodeInspectInput, outputSchema: z.json(), approval: "never" }).client(),
  defineAiTool({ name: "code_interact", description: "Operate a control or answer a pending modal using its exact snapshot ID. Buttons need only id; controls use a structured event in value, such as {type:change,value:...} or {type:select,key:...}. Returns the resulting state. Use null to cancel a modal.", inputSchema: CodeInteractInput, outputSchema: z.json(), approval: "never" }).client(),
  defineAiTool({ name: "code_stop", description: "Stop and release an isolated test run.", inputSchema: CodeStopInput, outputSchema: z.json(), approval: "never" }).client(),
  defineAiTool({ name: "code_open", description: "Show the app beside the chat without starting it. For one-off calculations, return the result instead of opening an app.", inputSchema: CodeOpenInput, outputSchema: z.json(), approval: "never" }).client(),
  defineAiTool({ name: "code_export", description: "Copy a captured output file from a test run into the chat. Returns a path for normal file tools and presentation.", inputSchema: CodeExportInput, outputSchema: z.json(), approval: "never" }).client(),
];

export const createDefaultCloudAiTools = () => [createCloudAiSurveyTool(), createCloudAiTextEditorTool()];

/** Built-ins advertised through discovery and loaded only when needed. */
export const CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES = new Set<string>([
  ...CODE_RUNTIME_TOOL_NAMES,
  ...Object.keys(CODE_SOURCE_TOOLS),
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
    ...createCodeSourceTools(),
    createCloudAiListFilesTool(),
    createCloudAiReadFileTool(),
    createCloudAiFetchFileTool(),
    createCloudAiWriteFileTool(),
    createCloudAiMarkdownToPdfTool(),
    createCloudAiPresentTool(),
    createCloudAiCalculateTool(),
    createCloudAiViewImageTool(),
    createCloudAiTranscribeAudioTool(),
  ];
  const firecrawlConfigured =
    config && "firecrawlApiKey" in config ? Boolean(config.firecrawlApiKey?.trim()) : await isCloudAiFirecrawlConfigured();
  if (firecrawlConfigured) {
    tools.push(createCloudAiWebSearchTool({ apiKey: config?.firecrawlApiKey, fetch: config?.fetch }));
    tools.push(createCloudAiWebExtractTool({ apiKey: config?.firecrawlApiKey, fetch: config?.fetch }));
  }
  return tools;
};
