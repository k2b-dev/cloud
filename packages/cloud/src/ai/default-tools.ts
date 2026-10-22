import { z } from "zod";
import { createCloudAiMapTool } from "./map-tool";
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
  CLOUD_AI_GROUP_MAX_CHARTS,
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
import {
  CloudAiLoadLocalSkillInputSchema,
  CloudAiLoadLocalSkillOutputSchema,
  CloudAiLocalDownloadInputSchema,
  CloudAiLocalDownloadOutputSchema,
  CloudAiLocalListInputSchema,
  CloudAiLocalListOutputSchema,
  CloudAiLocalMoveInputSchema,
  CloudAiLocalMoveOutputSchema,
  CloudAiLocalReadInputSchema,
  CloudAiLocalReadOutputSchema,
  CloudAiLocalUploadInputSchema,
  CloudAiLocalUploadOutputSchema,
  CloudAiLocalWriteInputSchema,
  CloudAiLocalWriteOutputSchema,
} from "./local-tool-contracts";
import { createCloudAiMarkdownToPdfTool } from "./markdown-pdf-tool";
import { createAiTodoTool } from "./todo-tool";
import { defineAiTool } from "./tools";
import type { AiChatTurnRunConfig, AiDataBoundary, AiRuntimeTool } from "./types";
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
      "Show one highlight figure you already have, such as a status, metric or short result, as a stat tile in the chat. Keep the value to a short figure or status and the caption to one line. Several figures computed in code_run go through cloud.view.stats in the run, not several card calls; tables, lists and longer explanations stay Markdown. Keep all fields flat; do not pass arrays or nested objects.",
    inputSchema: CloudAiCardInputSchema,
    outputSchema: CloudAiCardOutputSchema,
    approval: "never",
    promptHint: "show one highlight figure already known; several computed figures use cloud.view.stats in code_run.",
  }).clientView();

export const createCloudAiChartTool = () =>
  defineAiTool({
    name: "chart",
    description: `Show one chart in the chat from a few values you already have that did not come from a code run, such as figures from the conversation, a web page or a small capability result: bar, line (area: true fills it), scatter, pie, donut, histogram, gauge, sparkline, boxplot, heatmap, barGauge or stat. Several related measures go into one call as a group of small charts (charts, at most ${CLOUD_AI_GROUP_MAX_CHARTS}); linkX shares the x cursor between line charts with the same kind of x. There is no second y axis: compare measures with different units as a group. Cloud draws it with the renderer of cloud.chart() and gives the reader a data table and Copy data; no code, sandbox or app check is involved. Values computed in code_run never go here: the script shows them itself with cloud.view.chart, cloud.view.group, cloud.view.table, cloud.view.stats, cloud.view.details or cloud.view.explorer, and you present the returned path. Aggregate first. Say what the chart shows in title and put the unit, period or source in subtitle; formats are data ({ style: "percent" } takes fractions). The chart has no state, filters or actions: filters, steps and comparison over computed rows come from cloud.view.explorer in code_run; anything else the person interacts with, such as a calculator, converter or form, is a Studio app built with code_create. After the chart, state the finding instead of repeating its values.`,
    inputSchema: CloudAiChartInputSchema,
    outputSchema: CloudAiChartOutputSchema,
    approval: "never",
    promptHint:
      "show a few values you already have (not from a code run) as a chart in the chat. Code results use cloud.view.* and present; filters, steps and comparison use cloud.view.explorer in code_run; an app or tool to interact with is a Studio app (code_create).",
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
      "Run one Bash command in the workspace folder on the user's computer, as the user's OS account. Use it only when no file or Cloud tool fits; the client may ask the user first, and a run does not prove that the user saw the command.",
    inputSchema: CloudAiLocalBashInputSchema,
    outputSchema: CloudAiLocalBashOutputSchema,
    approval: "never",
    promptHint: "use local_bash only when no local file tool or Cloud tool fits; check status, exit code, and output.",
  }).client();

/** File tools a local client runs in the user's workspace folder; the client applies its path rules and questions. */
export const createCloudAiLocalTools = () => [
  defineAiTool({
    name: "local_list",
    description:
      "List files and folders in the user's local workspace, optionally recursive or filtered by a case-insensitive glob such as **/*.pdf, in pages of up to 1000 entries with size and modification time. Folders outside the workspace ask the user first.",
    inputSchema: CloudAiLocalListInputSchema,
    outputSchema: CloudAiLocalListOutputSchema,
    approval: "never",
  }).client(),
  defineAiTool({
    name: "local_read",
    description:
      "Read a local text file with line numbers, 16 KiB by default and 64 KiB at most per call; continue with nextOffset. PDFs, images, and office or spreadsheet files are uploaded to this chat instead, and the result names the chat path for read_file or view_image.",
    inputSchema: CloudAiLocalReadInputSchema,
    outputSchema: CloudAiLocalReadOutputSchema,
    approval: "never",
  }).client(),
  defineAiTool({
    name: "local_upload",
    description:
      "Upload up to 64 local files to this chat and return their chat paths, so Cloud tools such as read_file, view_image, and code mode can use them. Uploads stay in the chat until it is deleted; each file can have up to 50 MB.",
    inputSchema: CloudAiLocalUploadInputSchema,
    outputSchema: CloudAiLocalUploadOutputSchema,
    approval: "never",
  }).client(),
  defineAiTool({
    name: "local_download",
    description:
      "Save a chat file, text or binary, into the local workspace and create missing folders. It never overwrites an existing file unless replace is true, which asks the user.",
    inputSchema: CloudAiLocalDownloadInputSchema,
    outputSchema: CloudAiLocalDownloadOutputSchema,
    approval: "never",
  }).client(),
  defineAiTool({
    name: "local_write",
    description:
      "Write a local text file of up to 100 KiB: create makes a new file and fails if one exists, append adds to an existing file, and replace overwrites one. Append and replace ask the user.",
    inputSchema: CloudAiLocalWriteInputSchema,
    outputSchema: CloudAiLocalWriteOutputSchema,
    approval: "never",
  }).client(),
  defineAiTool({
    name: "local_move",
    description:
      "Rename or move up to 64 files or folders inside the workspace in one batch, which the user confirms once as a list. It never overwrites: if a target exists, nothing moves and the result names the conflicts.",
    inputSchema: CloudAiLocalMoveInputSchema,
    outputSchema: CloudAiLocalMoveOutputSchema,
    approval: "never",
  }).client(),
  defineAiTool({
    name: "load_local_skill",
    description:
      "Load a Skill marked [local] in the Skills section by its exact name. Returns its instructions, folder, and file list; read referenced files with local_read.",
    inputSchema: CloudAiLoadLocalSkillInputSchema,
    outputSchema: CloudAiLoadLocalSkillOutputSchema,
    approval: "never",
  }).client(),
];

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
      "For file analysis, data transformations or combining Cloud data, run a short one-off script with code_run; its computed views come from cloud.view.* in the script and present. Load assistant-code-mode for its runtime APIs; no saved app is required.",
    description:
      "Run one-off script code OR a saved script resource in the isolated worker. Optional resourceId binds one-off code to existing app data (Manage required), without editing its source. Includes cloud.capabilities.run(name,input) to chain Cloud capabilities in JavaScript; load assistant-code-mode for its runtime APIs. Scripts read explicit chat inputPaths. Returns output, logs, captured files and view references for agent inspection only. Show computed views with cloud.view.chart, cloud.view.group, cloud.view.table, cloud.view.stats, cloud.view.details or cloud.view.explorer in the script, then present({path}) each returned view; never retype run values into chart arguments, files or Markdown. Apps with an index.html interface do not run here: show them with code_open or code_present. Runs use real shared and personal data; database writes and capability effects keep normal permissions and approvals.",
    inputSchema: CodeRunInput,
    outputSchema: z.json(),
    approval: "never",
  }).server(runManagedCodeTool("code_run")),
  defineAiTool({
    name: "code_inspect",
    description:
      "Inspect a script run: status, progress, errors, logs, output, captured files and view references. Use waitMs to wait for background work.",
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
      "Show a saved Studio app beside the chat without starting it; HTML apps require a passing code_check for the current files and tables. When the person only wants one calculated result, answer it instead of building an app.",
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
      "Show a saved Studio app as a card in this chat: pass its id after a passing code_check for its current files and tables; it runs live with its data, and the person starts the card with a click. Every app, calculator, converter, form or tool the person asks for is a Studio app created with code_create; code_open shows it beside the chat instead. files (index.html plus optional style.css and app.js) instead of id show a throwaway card that is not saved and does not appear in Studio: only when the person explicitly asks for a preview they do not want to keep, after a passing code_check for exactly these files. Static problems such as CDN scripts, inline handlers or a missing index.html are rejected before anything is saved.",
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

/** Server-run Code Mode and declared client tools, excluding app opening and secret entry under a mandate. */
export const createAiTurnCodeAndClientTools = (config: Pick<AiChatTurnRunConfig, "clientToolIds" | "mandate">) =>
  [createCloudAiLocalBashTool(), ...createCloudAiLocalTools(), ...createCloudAiCodeTools()].filter(
    (tool) =>
      (tool.location === "server" || config.clientToolIds?.some((name) => name === tool.def.name)) &&
      !(config.mandate && ["code_open", "code_secret"].includes(tool.def.name)),
  );

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
  "map",
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
    createCloudAiMapTool(),
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
