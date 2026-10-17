export {
  CODE_RUNTIME_TOOL_NAMES,
  CodeActionInput,
  CodeCheckInput,
  CodeResourceId,
  CodeRuntimeInput,
  CodeToolFailure,
  parseCodeToolInput,
} from "./browser-code-contracts";
export { type AiTaskRequest, type AiTaskRequestInput, AiTaskRequestSchema } from "./task-contracts";
export { type AiTodoPlan, parseAiTodoPlan } from "./todo-contracts";

import { AI_TURN_ATTACHMENT_MAX_ITEMS } from "./limits";
import type { AiConversation, AiDraftContentPart } from "./types";

export {
  type CloudAiChartColumn,
  type CloudAiChartRow,
  type CloudAiChartTable,
  chartDrawingIssue,
  cloudAiChartLegend,
  cloudAiChartMarkKey,
  cloudAiChartMarks,
  cloudAiChartReferenceMark,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
  cloudAiChartTable,
  cloudAiChartTooltip,
  cloudAiChartXValueFormat,
  cloudAiNumberFormatters,
} from "./chart-block";
export { parseAiSse } from "./client/transport";
export {
  CLOUD_AI_CHART_MAX_SERIES,
  CLOUD_AI_CHART_MAX_VALUES,
  CLOUD_AI_GROUP_MAX_CHARTS,
  CLOUD_AI_TEXT_EDITOR_MAX_CHARS,
  CLOUD_AI_VIEW_MAX_MARKS,
  CloudAiCardInputSchema,
  type CloudAiChartInput,
  CloudAiChartInputSchema,
  type CloudAiDateFormat,
  type CloudAiFormat,
  CloudAiLocalBashInputSchema,
  type CloudAiNumberFormat,
  CloudAiSurveyInputSchema,
  CloudAiSurveyOutputSchema,
  CloudAiTextEditorInputSchema,
  CloudAiTextEditorOutputSchema,
  cloudAiAppChartSchema,
  cloudAiChartSchema,
  cloudAiFormatSchema,
  cloudAiNumberFormatSchema,
  parseCloudAiChartInput,
} from "./default-tool-contracts";
export { guessAiMediaType } from "./file-media-type";
export { AI_PROJECT_FILE_MOUNT, AI_SKILL_FILE_MOUNT } from "./file-mount";
export { AI_IMAGE_INPUT_MAX_BYTES, AI_TURN_ATTACHMENT_MAX_ITEMS, AI_TURN_IMAGE_MAX_TOTAL_BYTES } from "./limits";
export {
  AI_LOCAL_BATCH_MAX_ITEMS,
  AI_LOCAL_INSTRUCTIONS_MAX_BYTES,
  AI_LOCAL_LIST_MAX_LIMIT,
  AI_LOCAL_READ_MAX_BYTES,
  AI_LOCAL_SELECTED_SKILLS_MAX_ITEMS,
  AI_LOCAL_SKILL_FILES_MAX_ITEMS,
  AI_LOCAL_SKILLS_MAX_ITEMS,
  AI_LOCAL_TOOL_NAMES,
  AI_LOCAL_WRITE_MAX_BYTES,
  type AiLocalClient,
  AiLocalClientSchema,
  type AiLocalContext,
  AiLocalContextSchema,
  type AiLocalToolName,
  type CloudAiLoadLocalSkillInput,
  CloudAiLoadLocalSkillInputSchema,
  type CloudAiLoadLocalSkillOutput,
  CloudAiLoadLocalSkillOutputSchema,
  type CloudAiLocalDownloadInput,
  CloudAiLocalDownloadInputSchema,
  type CloudAiLocalDownloadOutput,
  CloudAiLocalDownloadOutputSchema,
  type CloudAiLocalListInput,
  CloudAiLocalListInputSchema,
  type CloudAiLocalListOutput,
  CloudAiLocalListOutputSchema,
  type CloudAiLocalMoveInput,
  CloudAiLocalMoveInputSchema,
  type CloudAiLocalMoveOutput,
  CloudAiLocalMoveOutputSchema,
  type CloudAiLocalReadInput,
  CloudAiLocalReadInputSchema,
  type CloudAiLocalReadOutput,
  CloudAiLocalReadOutputSchema,
  type CloudAiLocalUploadInput,
  CloudAiLocalUploadInputSchema,
  type CloudAiLocalUploadOutput,
  CloudAiLocalUploadOutputSchema,
  type CloudAiLocalWriteInput,
  CloudAiLocalWriteInputSchema,
  type CloudAiLocalWriteOutput,
  CloudAiLocalWriteOutputSchema,
} from "./local-tool-contracts";
export {
  AI_SKILL_DESCRIPTION_MAX_CHARS,
  AI_SKILL_EXTRA_FRONTMATTER_MAX_CHARS,
  AI_SKILL_INSTRUCTIONS_MAX_CHARS,
  AI_SKILL_NAME_MAX_CHARS,
  AI_SKILL_REFERENCE_MAX_CHARS,
  AI_SKILL_REFERENCE_MAX_ITEMS,
  AI_SKILL_REFERENCE_PATH_PATTERN,
  AI_SKILL_REFERENCES_MAX_CHARS,
  type AiSkillDocument,
  type AiSkillReferenceInput,
  isAiSkillManualOnly,
  mountAiSkillInstructionLinks,
  parseAiSkillMarkdown,
  serializeAiSkillMarkdown,
  splitAiSkillMarkdown,
  validateAiSkillReferences,
} from "./skill-format";
export { isAiImageMediaType } from "./types";

export type LaunchAssistantInput = {
  title?: string;
  projectId?: string;
  /** Stable application id when another Cloud application explicitly launches this chat. */
  launchedByAppId?: string;
  draft?: { content: Array<Extract<AiDraftContentPart, { type: "text" | "resource" }>> };
  files?: File[];
  preloadTools?: Array<{ name: string } | { appId: string; kind: "query" | "action"; id: string }>;
  /** Optional immutable ceiling of built-in names and qualified capability IDs. */
  allowedTools?: string[];
  /** Exact enabled Skill names, resolved into ordinary removable resource attachments. */
  skills?: string[];
};

export type AssistantLaunch = {
  conversation: AiConversation;
  href: string;
};

export const launchAssistant = async (input: LaunchAssistantInput): Promise<AssistantLaunch> => {
  const { files = [], ...createInput } = input;
  if (files.length > AI_TURN_ATTACHMENT_MAX_ITEMS) {
    throw new Error(`Assistant drafts can attach at most ${AI_TURN_ATTACHMENT_MAX_ITEMS} files`);
  }
  if ((input.draft?.content.length ?? 0) + files.length > 20) {
    throw new Error("Assistant drafts can contain at most 20 parts");
  }
  const response = await fetch("/api/ai/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createInput),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "Assistant chat could not be created");
  }
  let conversation = (await response.json()) as AiConversation;
  try {
    if (files.length > 0) {
      const uploaded = await Promise.all(
        files.map(async (file) => {
          const form = new FormData();
          form.set("file", file);
          const upload = await fetch(`/api/ai/conversations/${encodeURIComponent(conversation.id)}/files`, { method: "POST", body: form });
          if (!upload.ok) throw new Error(`Could not attach ${file.name}`);
          return (await upload.json()) as { file: Omit<Extract<AiDraftContentPart, { type: "file" }>, "type"> };
        }),
      );
      const draftResponse = await fetch(`/api/ai/conversations/${encodeURIComponent(conversation.id)}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: conversation.draft.revision,
          content: [...conversation.draft.content, ...uploaded.map((item) => ({ type: "file" as const, ...item.file }))],
        }),
      });
      if (!draftResponse.ok) throw new Error("Assistant draft attachments could not be saved");
      conversation = { ...conversation, draft: (await draftResponse.json()) as AiConversation["draft"] };
    }
  } catch (error) {
    await fetch(`/api/ai/conversations/${encodeURIComponent(conversation.id)}/archive`, { method: "POST" }).catch(() => undefined);
    throw error;
  }
  return {
    conversation,
    href: `/app/assistant?conversation=${encodeURIComponent(conversation.id)}`,
  };
};

export {
  CHAT_TASK_REASON_CODES,
  type ChatTaskReason,
  type ChatTaskReasonCode,
  chatTaskLocale,
  chatTaskReasonSentence,
  chatTaskReasonState,
  chatTaskStopSentence,
} from "./chat-task-reasons";
export {
  CLOUD_AI_STATS_MAX_ITEMS,
  CLOUD_AI_TABLE_MAX_COLUMNS,
  CLOUD_AI_TABLE_MAX_ROWS,
  CLOUD_AI_VIEW_DIRECTORY,
  CLOUD_AI_VIEW_MAX_BYTES,
  CLOUD_AI_VIEW_SUFFIX,
  type CloudAiChartView,
  type CloudAiDetailsView,
  type CloudAiExplorerRequest,
  type CloudAiExplorerView,
  type CloudAiGroupView,
  type CloudAiStatsView,
  type CloudAiTableView,
  type CloudAiView,
  type CloudAiViewReference,
  type CloudAiViewSummary,
  CloudAiViewSummarySchema,
  type CloudAiViewTable,
  checkCloudAiView,
  cloudAiDetailsRows,
  cloudAiExplorerControls,
  cloudAiExplorerState,
  cloudAiStatsTiles,
  cloudAiTableTsv,
  cloudAiViewSummary,
  cloudAiViewTable,
  isAiViewFile,
  isAiViewPath,
  parseCloudAiChartToolView,
  parseCloudAiView,
  sortCloudAiViewRows,
} from "./view-block";
