import { onCleanup, onMount } from "solid-js";

/** How long after a person's own input a change of the box's content still counts as theirs. */
const OWN_INPUT_WINDOW_MS = 1000;
/** Keys that only move the caret or the focus never change what the box holds. */
const NAVIGATION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Tab",
  "Escape",
  "Shift",
  "Control",
  "Alt",
  "Meta",
]);

/**
 * The reply box's height is its content (Höhenmodell A): head, text, attachments, signature, quote card, and bar, up to
 * the box's own `max-height`. Only the person's own input measures it again: typing, pasting, a dropped or removed
 * attachment, the quote card opened, closed, removed or added, recipients or Cc changed. Focus, saving, hints from
 * outside, and text from someone writing along never change the height: more content scrolls in the box's one
 * scrolling surface, less content keeps its room until the next own input. So the page below never moves by itself.
 *
 * The box carries `data-compose-fitted` once it holds a measured height; until then its CSS decides (a reserved height
 * above the conversation, so nothing below moves while the draft loads).
 */
export function createComposeFit(parts: {
  surface: () => HTMLElement | undefined;
  body: () => HTMLElement | undefined;
  content: () => HTMLElement | undefined;
  /** Parts above and below the scrolling surface whose own changes also count (the head grows with recipients). */
  frame: () => HTMLElement[];
}) {
  let ownInputAt = Number.NEGATIVE_INFINITY;
  let frame = 0;
  const fit = () => {
    frame = 0;
    const surface = parts.surface();
    const body = parts.body();
    const content = parts.content();
    if (!surface || !body || !content || !surface.isConnected) return;
    const style = getComputedStyle(body);
    const room = Number.parseFloat(getComputedStyle(content.nextElementSibling ?? content).minHeight) || 0;
    const natural =
      surface.offsetHeight -
      body.clientHeight +
      content.offsetHeight +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom) +
      (content.nextElementSibling ? room : 0);
    const cap = Number.parseFloat(getComputedStyle(surface).maxHeight);
    const height = Math.ceil(Number.isFinite(cap) ? Math.min(cap, natural) : natural);
    surface.style.height = `${height}px`;
    surface.setAttribute("data-compose-fitted", "");
  };
  const request = () => {
    if (!frame) frame = requestAnimationFrame(fit);
  };
  const markOwn = (event: Event) => {
    if (event instanceof KeyboardEvent && (NAVIGATION_KEYS.has(event.key) || event.isComposing)) return;
    ownInputAt = performance.now();
  };
  onMount(() => {
    const surface = parts.surface();
    const content = parts.content();
    if (!surface || !content) return;
    const events = ["input", "paste", "cut", "drop", "keydown", "pointerup", "change"] as const;
    for (const type of events) surface.addEventListener(type, markOwn, true);
    // The first measure stays the CSS's; afterwards a size change that follows the person's own input fits the box.
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      if (performance.now() - ownInputAt <= OWN_INPUT_WINDOW_MS) request();
    });
    observer.observe(content);
    for (const part of parts.frame()) observer.observe(part);
    onCleanup(() => {
      observer.disconnect();
      for (const type of events) surface.removeEventListener(type, markOwn, true);
      if (frame) cancelAnimationFrame(frame);
    });
  });
  return {
    /** Fits now, for an own action that changes the content without an event inside the box (an upload finished). */
    fitAfterOwnAction: () => {
      ownInputAt = performance.now();
      request();
    },
  };
}
