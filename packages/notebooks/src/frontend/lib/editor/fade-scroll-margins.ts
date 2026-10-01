import { EditorView } from "@codemirror/view";

/**
 * The note editor grows inside a `ScrollArea`, whose fades cover its top and
 * bottom edge while more content remains there. Declared as `scroll-padding`,
 * the browser resolves the fade to pixels on the actual element.
 */
export const fadeScrollPadding = "var(--scroll-fade-top, 0px) var(--scroll-fade-bottom, 0px)";

/**
 * CodeMirror scrolls the cursor into view itself and ignores CSS
 * `scroll-padding`, so typing, Enter, paste, and arrow keys would leave the
 * cursor line under the fade. This passes the scroll container's padding on as
 * CodeMirror scroll margins; pointer scrolling is unaffected.
 */
export const fadeScrollMarginsExtension = (container: () => HTMLElement | undefined) =>
  EditorView.scrollMargins.of(() => {
    const element = container();
    if (!element) return null;
    const style = getComputedStyle(element);
    return { top: Number.parseFloat(style.scrollPaddingTop) || 0, bottom: Number.parseFloat(style.scrollPaddingBottom) || 0 };
  });
