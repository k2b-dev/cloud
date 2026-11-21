import { createSignal } from "solid-js";

/** The one-time hint that tabs beside the chat can be arranged was dismissed on this browser; the page reads it. */
export const ASSISTANT_PANES_HINT_COOKIE = "assistant_panes_hint";
export const dismissAssistantPanesHint = () => {
  document.cookie = `${ASSISTANT_PANES_HINT_COOKIE}=seen; Max-Age=31536000; Path=/; SameSite=Lax`;
};

/**
 * How "In this chat" shows (Gustav flat): a column docked beside the chat, a drawer over the chat when the column has no
 * room or tabs are open, or a phone sheet.
 */
export type ChatContextMode = "column" | "drawer" | "sheet";

/** The presentation the layout's container and media queries chose, read from `--assistant-context-mode`. */
export const chatContextMode = (layout: Element): ChatContextMode => {
  const mode = getComputedStyle(layout).getPropertyValue("--assistant-context-mode").trim();
  return mode === "column" || mode === "sheet" ? mode : "drawer";
};

/**
 * The button of "In this chat" and the state of its column. CSS decides whether there is room for the column; the
 * person may close it (the button in the chat's head brings it back). Without room the button opens the same column
 * as a drawer over the chat, and on phones a sheet.
 */
export const createChatContextHost = (options: { onSheet: () => void }) => {
  const [closed, setClosed] = createSignal(false);
  const [drawer, setDrawer] = createSignal(false);
  let button: HTMLElement | undefined;
  let heading: HTMLElement | undefined;
  /** After the column or drawer appears, the focus goes to its heading; after it closes, back to the button. */
  const focusLater = (target: () => HTMLElement | undefined) => requestAnimationFrame(() => target()?.focus());
  return {
    /** The person closed the docked column. */
    closed,
    /** The drawer is open. */
    drawer,
    buttonRef: (element: HTMLElement) => {
      button = element;
    },
    headingRef: (element: HTMLElement) => {
      heading = element;
    },
    toggle: () => {
      const layout = button?.closest(".assistant-chat-layout");
      if (!layout) return;
      const mode = chatContextMode(layout);
      if (mode === "sheet") return options.onSheet();
      if (mode === "column") setClosed(false);
      else if (drawer()) return setDrawer(false);
      else setDrawer(true);
      focusLater(() => heading);
    },
    /** Closes the column where it is docked, the drawer elsewhere. */
    close: () => {
      const layout = button?.closest(".assistant-chat-layout");
      if (layout && chatContextMode(layout) === "column") setClosed(true);
      setDrawer(false);
      focusLater(() => button);
    },
    closeDrawer: () => setDrawer(false),
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
