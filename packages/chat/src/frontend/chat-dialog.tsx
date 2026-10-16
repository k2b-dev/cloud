import { InlineGuidance, useLocale } from "@k2b/ui";
import type { JSX } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ConversationSchema } from "../service/contracts";
import { ChatRequestError, type createChatStore } from "./chat-store";

/** What the chat dialogs and the info panel need from the store; tests pass a fake. */
export type ChatDialogStore = Pick<
  ReturnType<typeof createChatStore>,
  "create" | "updateDetails" | "members" | "previewMembers" | "addMembers" | "updateMember" | "removeMember" | "leave" | "people"
>;
export type Conversation = z.infer<typeof ConversationSchema>;

export const useChatMessages = () => {
  const locale = useLocale();
  return () => chatMessages.resolve([locale()]).t;
};

/** The server's own message when it sent one, such as a rate limit or a group that is too large. */
export const errorMessage = (error: unknown, fallback: string) => (error instanceof ChatRequestError ? error.message : fallback);

/** A failed request inside a dialog: it stays open, and the message sits above its actions. */
export const DialogError = (props: { message: string }): JSX.Element => (
  <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
    {props.message}
  </InlineGuidance>
);

/** The action row of a chat dialog, like the standard prompts: at the end, and wrapping on narrow screens. */
export const DialogActions = (props: { children: JSX.Element }): JSX.Element => <div class="chat-dialog__actions">{props.children}</div>;
