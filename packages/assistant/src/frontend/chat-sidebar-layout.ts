import { createSignal } from "solid-js";

/**
 * The chat sidebar's presentation is decided by CSS: a column when the chat area has room and the person has not
 * closed it, otherwise a drawer over the chat's edge, and a sheet on phones. Only an explicit close of the column is
 * remembered, in a cookie the page reads, so the server renders the final layout.
 */
export const ASSISTANT_CONTEXT_COOKIE = "assistant_context";

export type ChatSidebarMode = "column" | "drawer" | "sheet";

/** Whether the request carries the remembered close of the sidebar column. */
export const assistantContextClosedFromCookie = (value: string | undefined): boolean => value === "closed";

/** Remembers or forgets that the person closed the column, for one year on this browser. */
export const rememberAssistantContextClosed = (closed: boolean) => {
  document.cookie = closed
    ? `${ASSISTANT_CONTEXT_COOKIE}=closed; Max-Age=31536000; Path=/; SameSite=Lax`
    : `${ASSISTANT_CONTEXT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
};

/** The presentation the layout's container and media queries chose, read from `--assistant-context-mode`. */
export const chatSidebarMode = (layout: Element): ChatSidebarMode => {
  const mode = getComputedStyle(layout).getPropertyValue("--assistant-context-mode").trim();
  return mode === "column" || mode === "sheet" ? mode : "drawer";
};

/** Opening and closing the chat sidebar in the presentation CSS chose. */
export const createChatSidebarHost = (options: { initialClosed: boolean; onSheet: () => void }) => {
  const [closed, setClosed] = createSignal(options.initialClosed);
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  let layout: HTMLElement | undefined;
  let toggle: HTMLElement | undefined;
  let heading: HTMLElement | undefined;
  return {
    /** The person closed the column; rendered as `data-context="closed"`. */
    closed,
    /** The drawer covers the chat's edge; rendered as `data-drawer="open"`. */
    drawerOpen,
    layoutRef: (element: HTMLElement) => {
      layout = element;
    },
    toggleRef: (element: HTMLElement) => {
      toggle = element;
    },
    headingRef: (element: HTMLElement) => {
      heading = element;
    },
    /** Closing the column is remembered; closing the drawer is not, it only covered the chat for a moment. */
    close: () => {
      if (layout && chatSidebarMode(layout) === "column") {
        setClosed(true);
        rememberAssistantContextClosed(true);
      } else setDrawerOpen(false);
      // The toggle shows once the new state reached the DOM.
      queueMicrotask(() => toggle?.focus());
    },
    open: () => {
      if (!layout) return;
      const mode = chatSidebarMode(layout);
      if (mode === "sheet") return options.onSheet();
      if (mode === "column") {
        setClosed(false);
        rememberAssistantContextClosed(false);
      } else setDrawerOpen(true);
      queueMicrotask(() => heading?.focus());
    },
    closeDrawer: () => setDrawerOpen(false),
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
