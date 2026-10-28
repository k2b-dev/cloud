import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Tooltip } from "../feedback/Tooltip";

/**
 * True while `element` sits in the collapsed sidebar rail, which shows icons
 * without labels. The stylesheet sets `--k2b-sidebar-rail` exactly where it
 * collapses the sidebar, so this follows the same container width and state.
 */
export const inSidebarRail = (element: Element | undefined): boolean =>
  element?.isConnected === true && getComputedStyle(element).getPropertyValue("--k2b-sidebar-rail").trim() === "1";

/** True while a label fades out because it does not fit. */
const clipped = (element: Element | null | undefined): boolean =>
  Boolean(element && (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth));

/**
 * A sidebar entry's name, or its `title`, in the hint the Cloud app rail uses.
 * In the collapsed rail it names the icon beside it at once. Elsewhere it
 * shows above the entry with the usual delay, and only when it says more than
 * the visible label: a label cut off, or a title with details. A native
 * `title` on `target` gives way to it, so no hint shows twice.
 */
export function SidebarRailHint(props: {
  target: () => HTMLElement | undefined;
  label: string | undefined;
  /** The element that holds keyboard focus for the entry, when that is not `target`. */
  focusTarget?: () => HTMLElement | undefined;
  /** The visible label text inside `target`. */
  labelSelector: string;
}): JSX.Element {
  const needed = () => {
    const target = props.target();
    if (inSidebarRail(target)) return true;
    const visible = target?.querySelector(props.labelSelector);
    return clipped(visible) || (visible?.textContent?.trim() ?? "") !== props.label?.trim();
  };
  // A long sidebar carries no hint for entries nobody points at: the hint
  // mounts on the first hover or focus that needs it (or that would show a
  // native title), before the tooltip's own pointerenter and focusin
  // listeners see that same gesture.
  const [armed, setArmed] = createSignal(false);
  onMount(() => {
    const target = props.target();
    const focusHost = props.focusTarget?.() ?? target;
    if (!target || !focusHost) return;
    const arm = (event: Event) => {
      if (armed() || (event as PointerEvent).pointerType === "touch") return;
      if (target.hasAttribute("title") || needed()) setArmed(true);
    };
    target.addEventListener("pointerover", arm);
    focusHost.addEventListener("focus", arm);
    onCleanup(() => {
      target.removeEventListener("pointerover", arm);
      focusHost.removeEventListener("focus", arm);
    });
  });
  return (
    <Show when={armed() && props.label}>
      {(label) => (
        <Tooltip
          target={props.target}
          focusTarget={props.focusTarget}
          content={label()}
          placement={inSidebarRail(props.target()) ? "right" : "top"}
          delay={inSidebarRail(props.target()) ? 0 : undefined}
          disabled={!needed()}
        />
      )}
    </Show>
  );
}
