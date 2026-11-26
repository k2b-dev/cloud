import { createSignal, onCleanup, onMount } from "solid-js";

/** Before the page measures, an editor takes the window less the shell's head and frame. */
const FIRST = "calc(100dvh - 120px)";
/** The editor never gets smaller than a few lines of text. */
const LEAST = 320;

/**
 * The height an editor takes inside its `Canvas`: from where it starts to the bottom of the window, kept on resize.
 *
 * k2b-ui gap: `Canvas` has no `fill` (take the rest of the pane's height) for a drawing that is the whole pane, such
 * as an editor or a document frame; the editor measures its place until then.
 */
export function createEditorFill() {
  const [height, setHeight] = createSignal(FIRST);
  let element: HTMLElement | undefined;
  const measure = () => {
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    setHeight(`${Math.max(LEAST, Math.floor(window.innerHeight - top - 8))}px`);
  };
  onMount(() => {
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.documentElement);
    addEventListener("resize", measure);
    onCleanup(() => {
      observer.disconnect();
      removeEventListener("resize", measure);
    });
  });
  return {
    height,
    ref: (value: HTMLElement) => {
      element = value;
    },
  };
}
