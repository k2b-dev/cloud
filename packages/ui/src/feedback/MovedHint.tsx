import { createEffect, createSignal, createUniqueId, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Button, ButtonLink } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import { announce } from "./announce";
import { positionTooltipSurface, type TooltipPlacement } from "./tooltip-position";

export type MovedHintAction = { label: string; href: string; onClick?: never } | { label: string; onClick: () => void; href?: never };

export type MovedHintProps = {
  /** The owner decides this on the server, so a dismissed hint never renders again. */
  open: boolean;
  /** Called once per open period when the person closes the hint or uses its action. */
  onDismiss: () => void;
  /** Render the hint directly after this element to preserve keyboard order. */
  target: () => HTMLElement | undefined;
  /** Short text naming the new place. */
  children: JSX.Element;
  action: MovedHintAction;
  placement?: TooltipPlacement;
  class?: string;
};

export function MovedHint(props: MovedHintProps): JSX.Element {
  const messages = useUiMessages();
  const textId = `k2b-moved-hint-${createUniqueId()}`;
  const [mounted, setMounted] = createSignal(false);
  const [dismissed, setDismissed] = createSignal(false);
  let surface: HTMLDivElement | undefined;
  let text: HTMLParagraphElement | undefined;
  let previousFocus: HTMLElement | undefined;
  let shown = false;
  let announced = false;

  const hide = () => {
    if (!shown) return;
    shown = false;
    try {
      surface?.hidePopover?.();
    } catch {
      // Cleanup can run after the surface disconnects.
    }
  };

  const dismiss = (restoreFocus: boolean): boolean => {
    if (!props.open || dismissed()) return false;
    const focusInside = surface?.contains(document.activeElement);
    const target = props.target();
    const returnTo =
      previousFocus?.isConnected && !previousFocus.matches(":disabled")
        ? previousFocus
        : target && (target.tabIndex >= 0 || target.hasAttribute("tabindex")) && !target.matches(":disabled")
          ? target
          : undefined;
    hide();
    if (restoreFocus && focusInside && returnTo) {
      returnTo.focus({ preventScroll: true });
    }
    setDismissed(true);
    props.onDismiss();
    return true;
  };

  createEffect(() => {
    if (!props.open) {
      setDismissed(false);
      previousFocus = undefined;
    }
  });
  onMount(() => setMounted(true));

  createEffect(() => {
    if (!mounted() || !props.open || dismissed()) return;
    const anchor = props.target();
    const placement = props.placement ?? "bottom";
    if (!surface || !anchor) return;

    // A target scrolled out of view, or clipped by its scroller, takes the hint along instead of leaving it
    // pinned to the viewport edge over unrelated content.
    let inView = typeof IntersectionObserver === "undefined";
    const position = () => {
      if (!props.open || dismissed() || !inView || !anchor.isConnected || anchor.getClientRects().length === 0) {
        hide();
        return;
      }
      if (!surface || typeof surface.showPopover !== "function") return;
      if (!shown) {
        try {
          surface.showPopover();
          shown = true;
        } catch {
          return;
        }
      }
      positionTooltipSurface(surface, anchor, placement);
      if (!announced) {
        announced = true;
        announce(text?.textContent ?? "");
      }
    };
    const focusIn = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !surface?.contains(event.relatedTarget)) {
        previousFocus = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : undefined;
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key !== "Escape" || !(event.target instanceof Node)) return;
      if (!surface?.contains(event.target) && !anchor.contains(event.target)) return;
      event.preventDefault();
      dismiss(true);
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    observer?.observe(anchor);
    const visibility =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries) => {
            inView = entries.at(-1)?.isIntersecting ?? inView;
            position();
          });
    visibility?.observe(anchor);
    surface.addEventListener("focusin", focusIn);
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, { capture: true, passive: true });
    position();
    onCleanup(() => {
      observer?.disconnect();
      visibility?.disconnect();
      surface?.removeEventListener("focusin", focusIn);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      hide();
    });
  });

  return (
    <Show when={props.open}>
      <div
        ref={surface}
        class={`k2b-moved-hint${props.class ? ` ${props.class}` : ""}`}
        popover="manual"
        role="group"
        aria-labelledby={textId}
        data-placement={props.placement ?? "bottom"}
      >
        <p ref={text} class="k2b-moved-hint__text" id={textId}>
          {props.children}
        </p>
        <div class="k2b-moved-hint__actions">
          <Show
            when={props.action.href !== undefined}
            fallback={
              <Button
                size="sm"
                variant="secondary"
                type="button"
                onClick={() => {
                  const action = props.action;
                  if (dismiss(false)) action.onClick?.();
                }}
              >
                {props.action.label}
              </Button>
            }
          >
            <ButtonLink size="sm" variant="secondary" href={props.action.href} onClick={() => dismiss(false)}>
              {props.action.label}
            </ButtonLink>
          </Show>
          <Button size="sm" variant="ghost" type="button" onClick={() => dismiss(true)}>
            {messages().movedHintDismiss}
          </Button>
        </div>
      </div>
    </Show>
  );
}
