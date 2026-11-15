import { createSignal } from "solid-js";

/** How the box "In this chat" shows: an island beside the chat, a popover under the chat's button, or a phone sheet. */
export type ChatContextMode = "column" | "popover" | "sheet";

/** The presentation the layout's container and media queries chose, read from `--assistant-context-mode`. */
export const chatContextMode = (layout: Element): ChatContextMode => {
  const mode = getComputedStyle(layout).getPropertyValue("--assistant-context-mode").trim();
  return mode === "column" || mode === "sheet" ? mode : "popover";
};

/**
 * The button of the box "In this chat". CSS decides whether the box is an island beside the chat or this button; the
 * button opens the box as a popover below it, or as a sheet on phones.
 */
export const createChatContextHost = (options: { onSheet: () => void }) => {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  let button: HTMLElement | undefined;
  return {
    /** The anchor while the popover is open. */
    anchor,
    buttonRef: (element: HTMLElement) => {
      button = element;
    },
    toggle: () => {
      if (anchor()) return setAnchor(undefined);
      const layout = button?.closest(".assistant-chat-layout");
      if (!layout || !button) return;
      if (chatContextMode(layout) === "sheet") return options.onSheet();
      setAnchor(button);
    },
    close: () => setAnchor(undefined),
  };
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
