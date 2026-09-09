import { createEffect, createUniqueId, type JSX, onCleanup, onMount, splitProps } from "solid-js";
import { positionTooltipSurface, type TooltipPlacement } from "./tooltip-position";

export type TooltipProps = {
  content: JSX.Element;
  target: () => HTMLElement | undefined;
  placement?: TooltipPlacement;
  delay?: number;
  disabled?: boolean;
};

export type TooltipAnchorProps = Omit<JSX.HTMLAttributes<HTMLSpanElement>, "content"> & Omit<TooltipProps, "target">;

export type TooltipTriggerProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "content"> & Omit<TooltipProps, "target">;

/**
 * Low-level tooltip surface for components that already own their target DOM
 * element. Most callers should use Button.tooltip, IconButton.tooltip, or
 * Tooltip.Anchor instead.
 */
function TooltipSurface(props: TooltipProps): JSX.Element {
  const tooltipId = `k2b-tooltip-${createUniqueId()}`;
  let surface: HTMLSpanElement | undefined;
  let target: HTMLElement | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let dismissedUntilLeave = false;

  const clearTimer = () => {
    if (openTimer) clearTimeout(openTimer);
    openTimer = undefined;
  };

  function dismissOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || !surface?.matches(":popover-open")) return;
    dismissedUntilLeave = true;
    close();
  }

  function close() {
    clearTimer();
    if (surface?.matches(":popover-open")) {
      try {
        surface.hidePopover();
      } catch {
        // The surface may disconnect during cleanup.
      }
    }
    document.removeEventListener("keydown", dismissOnEscape);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close);
  }

  const open = () => {
    clearTimer();
    if (props.disabled || dismissedUntilLeave || !surface || !target || surface.matches(":popover-open")) return;
    const show = () => {
      openTimer = undefined;
      if (props.disabled || !surface?.isConnected || !target) return;
      try {
        surface.showPopover();
      } catch {
        return;
      }
      positionTooltipSurface(surface, target, props.placement);
      document.addEventListener("keydown", dismissOnEscape);
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
    };
    const delay = props.delay ?? 250;
    if (delay <= 0) show();
    else openTimer = setTimeout(show, delay);
  };

  createEffect(() => {
    if (props.disabled) close();
  });

  onMount(() => {
    target = props.target();
    if (!target) return;

    const originalDescription = target.getAttribute("aria-describedby");
    const descriptions = new Set(originalDescription?.split(/\s+/).filter(Boolean) ?? []);
    descriptions.add(tooltipId);
    target.setAttribute("aria-describedby", [...descriptions].join(" "));

    const leave = () => {
      dismissedUntilLeave = false;
      close();
    };
    const focusOut = (event: FocusEvent) => {
      if (!target?.contains(event.relatedTarget as Node | null)) leave();
    };
    const pointerDown = () => {
      dismissedUntilLeave = true;
      close();
    };

    target.addEventListener("pointerenter", open);
    target.addEventListener("pointerleave", leave);
    target.addEventListener("pointerdown", pointerDown);
    target.addEventListener("focusin", open);
    target.addEventListener("focusout", focusOut);

    onCleanup(() => {
      close();
      if (originalDescription) target?.setAttribute("aria-describedby", originalDescription);
      else target?.removeAttribute("aria-describedby");
      target?.removeEventListener("pointerenter", open);
      target?.removeEventListener("pointerleave", leave);
      target?.removeEventListener("pointerdown", pointerDown);
      target?.removeEventListener("focusin", open);
      target?.removeEventListener("focusout", focusOut);
    });
  });

  return (
    <span ref={surface} id={tooltipId} role="tooltip" popover="manual" class="k2b-tooltip">
      {props.content}
    </span>
  );
}

/** Explicit tooltip target for non-button content. */
function TooltipAnchor(props: TooltipAnchorProps): JSX.Element {
  const [local, rest] = splitProps(props, ["children", "class", "content", "delay", "disabled", "placement"]);
  let target: HTMLSpanElement | undefined;

  return (
    <span {...rest} ref={target} class={`k2b-tooltip-wrapper ${local.class ?? ""}`}>
      {local.children}
      <TooltipSurface
        content={local.content}
        target={() => target}
        delay={local.delay}
        disabled={local.disabled}
        placement={local.placement}
      />
    </span>
  );
}

/** Native button target for specialized controls that do not use Button. */
function TooltipTrigger(props: TooltipTriggerProps): JSX.Element {
  const [local, rest] = splitProps(props, ["children", "content", "delay", "disabled", "placement", "ref"]);
  let target: HTMLButtonElement | undefined;
  const register = (element: HTMLButtonElement) => {
    target = element;
    if (typeof local.ref === "function") local.ref(element);
  };

  return (
    <>
      <button {...rest} ref={register} disabled={local.disabled}>
        {local.children}
      </button>
      <TooltipSurface
        content={local.content}
        target={() => target}
        delay={local.delay}
        disabled={local.disabled}
        placement={local.placement}
      />
    </>
  );
}

type TooltipComponent = ((props: TooltipProps) => JSX.Element) & {
  Anchor: (props: TooltipAnchorProps) => JSX.Element;
  Trigger: (props: TooltipTriggerProps) => JSX.Element;
};

export const Tooltip = TooltipSurface as TooltipComponent;
Tooltip.Anchor = TooltipAnchor;
Tooltip.Trigger = TooltipTrigger;

export type { TooltipPlacement } from "./tooltip-position";

export default Tooltip;
