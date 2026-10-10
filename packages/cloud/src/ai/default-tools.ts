import { z } from "zod";
import type { AccessSubject } from "../server";
import { resolveAssistantAudioModel } from "./assistant-models";
import { createCloudAiTranscribeAudioTool } from "./audio-tool";
import {
  CODE_RUNTIME_TOOL_NAMES,
  CodeActionInput,
  CodeCheckInput,
  CodeExportInput,
  CodeInspectInput,
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
  CloudAiChartInputSchema,
  CloudAiChartOutputSchema,
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
import { createCloudAiHtmlToPdfTool } from "./html-pdf-tool";
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
  type CloudAiChartInput,
  CloudAiChartInputSchema,
  type CloudAiChartOutput,
  CloudAiChartOutputSchema,
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

export const createCloudAiChartTool = () =>
  defineAiTool({
    name: "chart",
    description:
      "Show one chart in the chat from data you already have: bar, line (area: true fills it), scatter, pie, donut, histogram, gauge or sparkline. Cloud draws it with the renderer of cloud.chart() in Studio apps and gives the reader a data table and Copy data; no code, sandbox or app check is involved. Aggregate first. Compute derived numbers with calculate or code_run before charting them. Say what the chart shows in title and put the unit, period or source in subtitle. The chart has no state, filters or actions: when the person needs interaction, saved data or reuse, build a Studio app instead. After the chart, state the finding instead of repeating its values.",
    inputSchema: CloudAiChartInputSchema,
    outputSchema: CloudAiChartOutputSchema,
    approval: "never",
    promptHint:
      "show data you already have as a chart in the chat, without code. Build a Studio app only when the person needs interaction, saved data, or reuse.",
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
      "Open a trusted Secret input dialog. The user enters the value directly into encrypted Assistant storage; only configured/name returns. Never ask for a credential in chat, survey or app fields. Personal secrets are scoped to this chat or resource and bound to the exact HTTPS origin, header and prefix. Use cloud.http.secret(name,{prefix}) in cloud.http.fetch headers; load assistant-code-mode for HTTP details. Web UI required for secret entry; stored secrets also work from CLI.",
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
      "Run one-off script code OR a saved script resource in the isolated worker. Optional resourceId binds one-off code to existing app data (Manage required), without editing its source. Includes cloud.capabilities.run(name,input) to chain Cloud capabilities in JavaScript; load assistant-code-mode for its runtime APIs. Scripts read explicit chat inputPaths. Returns output, logs and captured files for agent inspection only. Apps with an index.html interface do not run here: show them with code_open or code_present. Runs use real shared and personal data; database writes and capability effects keep normal permissions and approvals.",
    inputSchema: CodeRunInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_run")),
  defineAiTool({
    name: "code_inspect",
    description: "Inspect a script run: status, progress, errors, logs, output and captured files. Use waitMs to wait for background work.",
    inputSchema: CodeInspectInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_inspect")),
  defineAiTool({
    name: "code_stop",
    description: "Stop and release an isolated test run.",
    inputSchema: CodeStopInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_stop")),
  defineAiTool({
    name: "code_open",
    description:
      "Show the app beside the chat without starting it; HTML apps require a passing code_check for the current files and tables. For one-off calculations, return the result instead of opening an app.",
    inputSchema: CodeOpenInput,
    outputSchema: z.json(),
    approval: "never",
  }).client(),
  defineAiTool({
    name: "code_check",
    description:
      "Mandatory HTML app self-test: write files and steps.json (at most 20 main-flow steps, ending in the filled main state), call code_check({id} OR {files}), fix every error and layout warning, call view_image({path, prompt: review.prompt}) for EVERY path in review.paths (screenshots and PDFs), fix what it finds and check again, then code_open/code_present/code_publish. Runs desktop 1280×800 and phone 390×844 in opposite themes on separate throwaway copies of database, shared KV/files and only your own KV.user. Steps run in both views; reload keeps the copy. Match accessible role/name, label or text exactly, then case-insensitively, then by substring; ambiguous targets fail with candidates, placeholders are never names. Fill numbers with a dot. Upload file is an app-relative source path or chat file path/name. AI runs for real; HTTP, capability effects and approvals are unavailable; read-only granted capabilities run except in background turns. Returns passed, content hash (files, steps and tables), height, issues, calls, captured downloads, three whole-page PNG chat paths (up to 2000 px tall; cropped marks a longer page), review and an untrusted aria tree (4 KiB). Passing means not broken; misaligned rows, also in PDFs, and broken values only warn. Self-test is a workflow guard, not a security mechanism. Aborting closes pages and discards copies. Bounded to 45 seconds, 1000 copied rows/16 MiB (schema only beyond), 64 downloads/250 MiB total/50 MiB per file.",
    inputSchema: CodeCheckInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_check")),
  defineAiTool({
    name: "code_present",
    description:
      "Show an HTML app as a card in this chat after a passing code_check for exactly these files and table definitions. Pass files (index.html plus optional style.css and app.js) for a one-off app without saved data, or the id of a saved app to run it live with its data. The person starts the card with a click. Static problems such as CDN scripts, inline handlers or a missing index.html are rejected before anything is saved. For a reusable app beside the chat use code_open.",
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

export const createDefaultCloudAiTools = () => [
  createAiTodoTool(),
  createCloudAiSurveyTool(),
  createCloudAiTextEditorTool(),
  createCloudAiChartTool(),
];

/** Built-ins advertised through discovery and loaded only when needed. */
export const CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES = new Set<string>([
  ...CODE_RUNTIME_TOOL_NAMES,
  ...Object.keys(CODE_SOURCE_TOOLS),
  "survey",
  "text_editor",
  "chart",
  "list_files",
  "write_file",
  "markdown_to_pdf",
  "html_to_pdf",
  "present",
  "read_cloud_resource",
]);

export const createConfiguredDefaultCloudAiTools = async (config?: {
  firecrawlApiKey?: string | null;
  accessSubject?: AccessSubject | null;
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
    createCloudAiHtmlToPdfTool(),
    createCloudAiPresentTool(),
    createCloudAiCalculateTool(),
    createCloudAiViewImageTool(),
  ];
  const audioModelConfigured = await resolveAssistantAudioModel(config?.accessSubject ?? null, config?.allowedDataBoundaries).then(
    () => true,
    () => false,
  );
  if (audioModelConfigured) tools.push(createCloudAiTranscribeAudioTool());
  const firecrawlConfigured =
    config && "firecrawlApiKey" in config ? Boolean(config.firecrawlApiKey?.trim()) : await isCloudAiFirecrawlConfigured();
  if (firecrawlConfigured) {
    tools.push(createCloudAiWebSearchTool({ apiKey: config?.firecrawlApiKey, fetch: config?.fetch }));
    tools.push(createCloudAiWebExtractTool({ apiKey: config?.firecrawlApiKey, fetch: config?.fetch }));
  }
  return tools;
};
