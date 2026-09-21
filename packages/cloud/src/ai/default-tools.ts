import { z } from "zod";
import { createCloudAiTranscribeAudioTool } from "./audio-tool";
import {
  CODE_RUNTIME_TOOL_NAMES,
  CodeActionInput,
  CodeExportInput,
  CodeInspectInput,
  CodeInteractInput,
  CodeOpenInput,
  CodePresentInput,
  CodeRunInput,
  CodeSecretInput,
  CodeStopInput,
} from "./browser-code-contracts";
import { runManagedCodeTool } from "./code-runtime-tools";
import { CODE_SOURCE_TOOLS } from "./code-source-contracts";
import { createCodeSourceTools } from "./code-source-tools";
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
import { createCloudAiFetchFileTool } from "./fetch-file-tool";
import {
  createCloudAiCalculateTool,
  createCloudAiListFilesTool,
  createCloudAiPresentTool,
  createCloudAiReadFileTool,
  createCloudAiWriteFileTool,
} from "./file-tools";
import { createCloudAiWebExtractTool, createCloudAiWebSearchTool, isCloudAiFirecrawlConfigured } from "./firecrawl-tools";
import { createCloudAiMarkdownToPdfTool } from "./markdown-pdf-tool";
import { createAiTodoTool } from "./todo-tool";
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

export const createCloudAiCodeTools = () => [
  defineAiTool({
    name: "code_secret",
    description:
      "Open a trusted Secret input dialog. The user enters the value directly into encrypted Assistant storage; only configured/name returns. Never ask for a credential in chat, survey, app controls or code_interact. Personal secrets are scoped to this chat or resource and bound to the exact HTTPS origin, header and prefix. Use secret(name,{prefix}) in http.fetch headers; load assistant-code-mode for HTTP details. Web UI required for secret entry; stored secrets also work from CLI.",
    inputSchema: CodeSecretInput,
    outputSchema: z.object({ configured: z.boolean(), name: z.string() }),
    approval: "never",
  }).client(),
  defineAiTool({
    name: "code_action",
    description:
      "Call one published Studio App action using its exact discovered name, publication and input schema. Discover with code_actions first. Use permission is sufficient; draft and management access are not granted. Runtime effects and approvals are real. Never repeat an uncertain mutation blindly.",
    inputSchema: CodeActionInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_action")),
  defineAiTool({
    name: "code_run",
    promptHint:
      "For file analysis, data transformations or combining Cloud data, run a short one-off script with code_run. Load assistant-code-mode for its runtime APIs; no saved app is required.",
    description:
      "Run a saved resource id OR one-off code in the isolated worker. Optional resourceId binds one-off code to existing app data (Manage required), without editing its source. Includes capabilities.run(name,input) to chain Cloud capabilities in JavaScript; load assistant-code-mode for its runtime APIs. Scripts accept current chat inputPaths; app test runs use them only as explicit picker fixtures. Returns output, logs and UI state for agent inspection only; use code_present to show a one-off visualization to the user. Local test storage is temporary; shared data, database writes and capability effects are real and keep normal permissions and approvals.",
    inputSchema: CodeRunInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_run")),
  defineAiTool({
    name: "code_inspect",
    description:
      "Inspect a test run: errors, logs, output, controls and pending modal. Use nodeId to inspect table rows or list items; follow pagination only as needed.",
    inputSchema: CodeInspectInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_inspect")),
  defineAiTool({
    name: "code_interact",
    description:
      "Operate a control or answer a pending modal using its exact snapshot ID. Buttons need only id; controls use event:{type:change,value:...} or event:{type:select,key:...}. Use answer for modal replies, or answer:null to cancel. Copy an interactions example from code_inspect; never send JSON as a string. Use steps:[{id,event?},...] for up to three known sequential interactions; stops on errors, modals or background work. Returns one resulting state with completedSteps and nextStep.",
    inputSchema: CodeInteractInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_interact")),
  defineAiTool({
    name: "code_stop",
    description: "Stop and release an isolated test run.",
    inputSchema: CodeStopInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_stop")),
  defineAiTool({
    name: "code_open",
    description: "Show the app beside the chat without starting it. For one-off calculations, return the result instead of opening an app.",
    inputSchema: CodeOpenInput,
    outputSchema: z.json(),
    approval: "never",
  }).client(),
  defineAiTool({
    name: "code_present",
    description:
      "Present a successful one-off run as a persistent interactive visualization in this chat. Requires code_run with code, without resourceId or saved app id. Saves source, selected inputs and UI preview. Users can activate controls and download the current view. Test runs are not visible until this succeeds. For reusable apps use code_open instead.",
    inputSchema: CodePresentInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_present")),
  defineAiTool({
    name: "code_export",
    description: "Copy a captured output file from a test run into the chat. Returns a path for normal file tools and presentation.",
    inputSchema: CodeExportInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_export")),
];

export const createDefaultCloudAiTools = () => [createAiTodoTool(), createCloudAiSurveyTool(), createCloudAiTextEditorTool()];

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
