import { createRoot } from "solid-js";
import { createWaitingQuestionFocus } from "./AssistantWaitingStrip";

/**
 * The landing of "Waiting for you" on its own, for a browser test: a scrolling timeline whose cards the test adds, as a
 * chat that is still loading would. `window.land(anchor)` runs the jump's focus; `window.gone` tells a missing card.
 */
const viewport = document.getElementById("viewport")!;
const content = document.getElementById("content")!;
const page = window as unknown as { land: (anchor: string) => Promise<void>; gone: boolean };
page.gone = false;
createRoot(() => {
  const focus = createWaitingQuestionFocus({
    onlyHere: () => null,
    viewport: () => viewport,
    content: () => content,
    scrollToAnchor: (anchor) => {
      const card = Array.from(content.querySelectorAll<HTMLElement>("[data-chat-anchor]")).find(
        (node) => node.dataset.chatAnchor === anchor,
      );
      card?.scrollIntoView({ block: "start" });
      return Boolean(card);
    },
    gone: () => {
      page.gone = true;
    },
  });
  page.land = (anchor) => focus.focus(anchor);
});
