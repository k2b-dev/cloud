export { AiTurnBlockView } from "./chat/blocks";

import { latestLoopUsage, latestUsage, latestUsageSnapshot, textFromMessage } from "./chat/message-utils";

export {
  AI_COMPOSER_TEXT_MAX_CHARS,
  AI_PASTED_TEXT_ATTACHMENT_THRESHOLD,
  type AiComposerAttachment,
  type AiComposerFileResult,
  type AiComposerSendInput,
  aiChatAttachments,
  aiChatModelOptions,
  aiComposerAttachmentRecords,
  aiComposerDraft,
  aiComposerFileAccept,
  aiComposerSendInput,
  createAiPastedTextFile,
  readAiComposerFiles,
  shouldAttachAiPastedText,
} from "./chat/composer-adapter";
export type {
  AiChatActions,
  AiTurnActionRequest,
} from "./chat/message-actions";
export type {
  AiForkMessageInput,
  AiRetryMessageInput,
} from "./chat/message-utils";
export { MAX_ATTACHMENTS as AI_TURN_ATTACHMENT_MAX_ITEMS } from "./chat/message-utils";
export {
  AiChatActionsProvider,
  type AiChatTimelineSession,
  type AiChatTimelineSource,
  AiChatTurnNavigator,
  type AiChatTurnNavigatorProps,
  createAiChatTimeline,
} from "./chat/presentation";

export const aiLatestUsage = latestUsage;
export const aiLatestLoopUsage = latestLoopUsage;
export const aiLatestUsageSnapshot = latestUsageSnapshot;
export const aiMessageText = textFromMessage;
