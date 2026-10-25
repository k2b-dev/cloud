import { createSignal } from "solid-js";

/**
 * The chat details are the workspace's shared Detail: a column where it fits, otherwise a drawer behind Details, and a
 * page on phones. Only an explicit close of the column is remembered, in a cookie the page reads, so the server
 * renders the final layout; parking the drawer or the phone page is not.
 */
export const ASSISTANT_CONTEXT_COOKIE = "assistant_context";

/** The chat details' `AppWorkspace.Detail` id. */
export const CHAT_DETAILS_ID = "assistant-chat-context";

/** The chat keeps a readable column beside the details; a narrower chat area shows them behind Details. */
export const CHAT_MAIN_MIN_WIDTH = 480;

/** Whether the request carries the remembered close of the details column. */
export const assistantContextClosedFromCookie = (value: string | undefined): boolean => value === "closed";

/** Remembers or forgets that the person closed the column, for one year on this browser. */
export const rememberAssistantContextClosed = (closed: boolean) => {
  document.cookie = closed
    ? `${ASSISTANT_CONTEXT_COOKIE}=closed; Max-Age=31536000; Path=/; SameSite=Lax`
    : `${ASSISTANT_CONTEXT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
};

/** The remembered visibility of the chat details, for `AppWorkspace.Detail`'s `open`, `onOpen`, and `onClose`. */
export const createChatSidebarHost = (options: { initialClosed: boolean }) => {
  const [closed, setClosed] = createSignal(options.initialClosed);
  const remember = (next: boolean) => {
    setClosed(next);
    rememberAssistantContextClosed(next);
  };
  return { closed, open: () => remember(false), close: () => remember(true) };
};

/**
 * After the chat scrolled to a result's turn, brings the element that delivered it (the present row or the
 * visualization) into view and returns it; null when it is not rendered or hidden, so the caller marks the turn.
 */
export const revealChatDelivery = (
  content: ParentNode | undefined,
  target: { callId: string | null; presentationId?: string | null },
): HTMLElement | null => {
  const selector = target.presentationId
    ? `[data-presentation-id="${CSS.escape(target.presentationId)}"]`
    : target.callId
      ? `[data-call-id="${CSS.escape(target.callId)}"]`
      : null;
  const element = selector ? content?.querySelector<HTMLElement>(selector) : null;
  if (!element || element.getClientRects().length === 0) return null;
  element.scrollIntoView({ block: "center" });
  return element;
};
