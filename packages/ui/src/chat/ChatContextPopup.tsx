import { createSignal, createUniqueId, type JSX, onCleanup, onMount, splitProps } from "solid-js";
import { positionTooltipSurface } from "../feedback/tooltip-position";
import { returnFocus, ringOnReturn } from "../internal/focus-return";

export type ChatContextPopupProps = Omit<
  JSX.ButtonHTMLAttributes<HTMLButtonElement>,
  "content" | "ref" | "onClick" | "onPointerEnter" | "onPointerLeave"
> & {
  content: JSX.Element;
  /** Runs each time the panel opens, for example to refresh its data. */
  onOpen?: () => void;
};

export type ChatContextPanelProps = { title: string; children?: JSX.Element };

/** Panel body shared by context details: a title, then progress, `dl` rows, and short `p` notes, grouped in `section`s when repeated. */
export function ChatContextPanel(props: ChatContextPanelProps): JSX.Element {
  return (
    <div class="k2b-chat-context__tooltip">
      <strong>{props.title}</strong>
      {props.children}
    </div>
  );
}

/** Context details support hover preview and deliberate click-to-pin without changing tooltip behavior. */
export function ChatContextPopup(props: ChatContextPopupProps): JSX.Element {
  const [local, rest] = splitProps(props, ["content", "children", "onOpen", "class"]);
  const id = `chat-context-${createUniqueId()}`;
  const [open, setOpen] = createSignal(false);
  let pinned = false;
  let triggerRing = true;
  let trigger: HTMLButtonElement | undefined;
  let surface: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The control inside the details that last had the focus, while it has not left them. */
  let focusedInside: Element | null = null;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const position = () => {
    if (open() && surface && trigger) positionTooltipSurface(surface, trigger, "top");
  };
  const show = () => {
    clear();
    if (!surface || open()) return;
    triggerRing = ringOnReturn(trigger);
    surface.showPopover();
    setOpen(true);
    position();
    local.onOpen?.();
  };
  const close = (restoreFocus = false) => {
    clear();
    pinned = false;
    focusedInside = null;
    // Before hiding, so the popover does not return focus on its own.
    if (restoreFocus) returnFocus(trigger, triggerRing);
    if (open()) surface?.hidePopover();
    setOpen(false);
  };
  const preview = (event: PointerEvent) => {
    clear();
    if (event.pointerType !== "touch" && !open()) timer = setTimeout(show, 250);
  };
  const leave = () => {
    clear();
    timer = setTimeout(() => {
      if (!pinned && !surface?.contains(document.activeElement)) close();
    }, 180);
  };
  onMount(() => {
    const resize = new ResizeObserver(position);
    if (surface) resize.observe(surface);
    // A focused control that leaves the DOM or turns disabled drops the focus to the page. WebKit sends no blur or
    // focusout for a removed element, so watch the details themselves and hold the focus in them.
    const holdFocus = new MutationObserver(() => {
      const active = document.activeElement;
      if (open() && focusedInside && (!active || active === document.body)) surface?.focus();
    });
    if (surface) holdFocus.observe(surface, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    const outside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (!path.includes(trigger!) && !path.includes(surface!)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open()) {
        event.preventDefault();
        event.stopPropagation();
        close(Boolean(surface?.contains(document.activeElement)));
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    onCleanup(() => {
      resize.disconnect();
      holdFocus.disconnect();
      clear();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    });
  });
  return (
    <>
      <button
        type="button"
        {...rest}
        class={local.class ?? "k2b-chat-context"}
        ref={trigger}
        aria-expanded={open()}
        aria-controls={id}
        aria-haspopup="dialog"
        onPointerEnter={preview}
        onPointerLeave={leave}
        onClick={() => {
          if (pinned) close();
          else {
            // A hover may have opened the popup before this click or key press pinned it.
            triggerRing = ringOnReturn(trigger);
            pinned = true;
            show();
          }
        }}
      >
        {local.children}
      </button>
      <div
        ref={surface}
        id={id}
        popover="manual"
        role="dialog"
        aria-label={props["aria-label"]}
        class="k2b-chat-context-popup"
        onPointerEnter={clear}
        onPointerLeave={leave}
        // A direct listener: the hold below must know the focused control even where delegation is not set up.
        on:focusin={(event) => {
          clear();
          focusedInside = event.target instanceof Element ? event.target : null;
        }}
        tabIndex={-1}
        onFocusOut={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node) {
            if (!surface?.contains(next) && next !== trigger) close();
            return;
          }
          // Focus that falls to nothing, because a control inside replaced itself (a retry that succeeded) or turned
          // disabled while it loads, stays in the details. Focus that moved elsewhere closes them.
          setTimeout(() => {
            const active = document.activeElement;
            if (!open() || surface?.contains(active)) return;
            if (!active || active === document.body) surface?.focus();
            else close();
          });
        }}
      >
        {local.content}
      </div>
    </>
  );
}
