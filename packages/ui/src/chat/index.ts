export type { ChatContextPanelProps, ChatContextPopupProps } from "./ChatContextPopup";

import { ChatContextPanel, ChatContextPopup } from "./ChatContextPopup";
import { ChatTasks } from "./ChatTasks";

export type { ChatTask, ChatTasksProps } from "./ChatTasks";

import { ChatComposer } from "./ChatComposer";
import { ChatDecision, ChatMark, ChatOutcome, ChatPreview } from "./ChatDecision";
import { ChatActivity, ChatActivityToggle, ChatContextUsage, ChatMessage } from "./ChatPrimitives";
import { ChatRoot } from "./ChatRoot";
import { ChatTimeline } from "./ChatTimeline";

export type {
  ChatCommand,
  ChatCommandContext,
  ChatCommandDraft,
  ChatCommandOpenResult,
  ChatCommandResult,
  ChatCommandScope,
  ChatCommandSearch,
  ChatCommandSection,
  ChatComposerPeople,
  ChatComposerProps,
  ChatComposerReply,
  ChatFileSelection,
  ChatPasteHandler,
  ChatPersonSuggestion,
} from "./ChatComposer";
export type {
  ChatDecisionProps,
  ChatMarkProps,
  ChatOutcomeProps,
  ChatPreviewExcerptProps,
  ChatPreviewHeaderProps,
  ChatPreviewLineProps,
  ChatPreviewPeopleProps,
  ChatPreviewProps,
  ChatPreviewReadMoreProps,
  ChatPreviewShowAllProps,
  ChatPreviewTitleProps,
} from "./ChatDecision";
export type { ChatActivityProps, ChatActivityToggleProps, ChatContextUsageProps, ChatMessageProps } from "./ChatPrimitives";
export { formatChatTokens } from "./ChatPrimitives";
export type { ChatRootProps } from "./ChatRoot";
export type { ChatActivityItem, ChatMessageItem, ChatTimelineItem, ChatTimelineProps } from "./ChatTimeline";
export type {
  ChatAction,
  ChatActivityTone,
  ChatAttachment,
  ChatComposerEmoji,
  ChatComposerMicrophone,
  ChatComposerState,
  ChatContextUsageData,
  ChatDecisionAnswer,
  ChatDecisionReason,
  ChatDecisionState,
  ChatDictationState,
  ChatMention,
  ChatMessageStatus,
  ChatModelOption,
  ChatOutcomeLine,
  ChatOutcomeTone,
  ChatPreviewHeaderRow,
  ChatPreviewPerson,
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
  Activity: Object.assign(ChatActivity, { Toggle: ChatActivityToggle }),
  Composer: ChatComposer,
  ContextUsage: ChatContextUsage,
  ContextPopup: ChatContextPopup,
  ContextPanel: ChatContextPanel,
  Decision: ChatDecision,
  Outcome: ChatOutcome,
  Preview: ChatPreview,
  Mark: ChatMark,
});

export { matchesChatCommand } from "./command-search";
export { reconcileChatMentions } from "./composer-document";

export { type ReactionPeopleInput, reactionPeople } from "./reaction-people";
