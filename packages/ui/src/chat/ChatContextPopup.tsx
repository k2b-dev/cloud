import { createSignal, createUniqueId, type JSX, onCleanup, onMount, splitProps } from "solid-js";
import { positionTooltipSurface } from "../feedback/tooltip-position";

export type ChatContextPopupProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "content" | "ref" | "onClick" | "onPointerEnter" | "onPointerLeave"> & { content: JSX.Element };

/** Context details support hover preview and deliberate click-to-pin without changing tooltip behavior. */
export function ChatContextPopup(props: ChatContextPopupProps): JSX.Element {
  const [local, rest] = splitProps(props, ["content", "children"]);
  const id = `chat-context-${createUniqueId()}`;
  const [open, setOpen] = createSignal(false);
  let pinned = false;
  let trigger: HTMLButtonElement | undefined;
  let surface: HTMLDivElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
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
    surface.showPopover();
    setOpen(true);
    position();
  };
  const close = (restoreFocus = false) => {
    clear();
    pinned = false;
    if (open()) surface?.hidePopover();
    setOpen(false);
    if (restoreFocus) trigger?.focus();
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
        ref={trigger}
        aria-expanded={open()}
        aria-controls={id}
        aria-haspopup="dialog"
        onPointerEnter={preview}
        onPointerLeave={leave}
        onClick={() => {
          if (pinned) close();
          else {
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
        onFocusIn={clear}
        onFocusOut={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || (!surface?.contains(next) && next !== trigger)) close();
        }}
      >
        {local.content}
      </div>
    </>
  );
}
