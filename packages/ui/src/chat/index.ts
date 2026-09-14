export type { ChatContextPopupProps } from "./ChatContextPopup";
import { ChatContextPopup } from "./ChatContextPopup";
import { ChatTasks } from "./ChatTasks";
export type { ChatTask, ChatTasksProps } from "./ChatTasks";
import { ChatComposer } from "./ChatComposer";
import { ChatActivity, ChatContextUsage, ChatMessage } from "./ChatPrimitives";
import { ChatRoot } from "./ChatRoot";
import { ChatTimeline } from "./ChatTimeline";

export type { ChatCommand, ChatCommandContext, ChatComposerProps, ChatFileSelection, ChatPasteHandler } from "./ChatComposer";
export type { ChatActivityProps, ChatContextUsageProps, ChatMessageProps } from "./ChatPrimitives";
export { formatChatTokens } from "./ChatPrimitives";
export type { ChatRootProps } from "./ChatRoot";
export type { ChatActivityItem, ChatMessageItem, ChatTimelineItem, ChatTimelineProps } from "./ChatTimeline";
export type {
  ChatAction,
  ChatActivityTone,
  ChatAttachment,
  ChatComposerState,
  ChatContextUsageData,
  ChatMessageStatus,
  ChatModelOption,
  ChatRole,
  ChatSubmitInput,
  ChatSubmitIntent,
  ChatUsage,
} from "./types";

/**
 * Portable, controlled chat surface. Applications own storage, streaming,
 * authorization, rich message rendering, and domain actions.
 */
export const Chat = Object.assign(ChatRoot, {
  Tasks: ChatTasks,
  Timeline: ChatTimeline,
  Message: ChatMessage,
  Activity: ChatActivity,
  Composer: ChatComposer,
  ContextUsage: ChatContextUsage,
  ContextPopup: ChatContextPopup,
});
