import { createEffect, createSignal, type JSX, onCleanup, children as resolveChildren, Show } from "solid-js";
import { usePopover } from "./behavior/overlays";
import { useTip } from "./behavior/tip";
import { alignTo, TriggerFace, type TriggerProps } from "./menu";
import { useOverlayMessages } from "./overlay-messages";
import { usePhone } from "./overlays";
import { PageLayer } from "./page-layer";

export type PopoverPanelProps = TriggerProps & {
  /** The heading of the panel, which also names it for assistive technology. */
  title?: string;
  /** What the panel shows: v2 primitives such as `Text`, `Facts`, `Check`, `Field`. */
  content: JSX.Element;
};

export type PopoverTipProps = {
  /** A short hint that shows after a moment on hover or keyboard focus, above the thing. */
  tip: string;
  /** The one element the hint belongs to, such as a `Button`; it gets no wrapper. */
  children: JSX.Element;
};

export type PopoverProps = PopoverPanelProps | PopoverTipProps;

/**
 * A panel behind a button, 280 px on a floating surface of 8 px radius, that does not block the page: Escape and a
 * press outside close it, focus moves in and back. The button looks like `Button`, like a menu's. On the phone (below
 * 768 px) the panel is a sheet from the bottom, and a button without words stays in a head as a menu's "…" does.
 */
const Panel = (props: PopoverPanelProps) => {
  const t = useOverlayMessages();
  const words = resolveChildren(() => props.children);
  const iconOnly = () => words() === undefined;
  const name = () => props.label ?? props.title ?? t().moreActions;
  const phone = usePhone();
  let trigger: HTMLElement | undefined;
  const [align, setAlign] = createSignal<"start" | "end">("start");
  const popover = usePopover(() => ({
    presentation: phone() ? "sheet" : "popover",
    onOpenChange: (open: boolean) => {
      if (open) setAlign(alignTo(trigger));
    },
  }));
  return (
    <>
      <popover.Trigger
        ref={(element: HTMLElement) => {
          trigger = element;
        }}
        disabled={props.disabled}
        class="k2-btn"
        data-k2-part="Button"
        data-variant={(props.variant ?? (iconOnly() ? "ghost" : "secondary")) === "secondary" ? undefined : (props.variant ?? "ghost")}
        data-icon-only={iconOnly() ? "" : undefined}
        data-menu={iconOnly() ? undefined : ""}
        // like a menu's "…": a button without words stays in a head on the phone, where the other buttons give way
        data-keep={iconOnly() ? "" : undefined}
        aria-label={iconOnly() ? name() : undefined}
        title={iconOnly() ? name() : undefined}
      >
        <TriggerFace icon={props.icon ?? (iconOnly() ? "dots" : undefined)} label={words()} iconOnly={iconOnly()} chevron={!iconOnly()} />
      </popover.Trigger>
      <popover.Popup class="k2-pop" data-k2-part="Popover" side="bottom" align={align()} sideOffset={4} collisionPadding={8}>
        <Show when={props.title}>{(title) => <popover.Title class="k2-pop-title">{title()}</popover.Title>}</Show>
        <div class="k2-pop-body">{props.content}</div>
      </popover.Popup>
    </>
  );
};

/** A hint on the thing itself: the words show above it after a moment and name or describe it for assistive technology. */
const Tip = (props: PopoverTipProps) => {
  const tip = useTip();
  const resolved = resolveChildren(() => props.children);
  const element = () => resolved.toArray().find((node): node is HTMLElement => node instanceof HTMLElement);
  createEffect(() => {
    const trigger = element();
    if (!trigger) return;
    // the browser's own hint (an icon button names itself in `title`) would show beside the tip; it comes back after
    const title = trigger.getAttribute("title");
    trigger.removeAttribute("title");
    const unbind = tip.bindTrigger(trigger);
    onCleanup(() => {
      unbind();
      if (title !== null) trigger.setAttribute("title", title);
    });
  });
  // the tip stands at the end of the page, so the thing stays the last child of its place (see PageLayer)
  return (
    <>
      {resolved()}
      <PageLayer from={element}>
        <tip.Popup class="k2-tip" data-k2-part="Popover" side="top" sideOffset={6} collisionPadding={8}>
          {props.tip}
        </tip.Popup>
      </PageLayer>
    </>
  );
};

/** A panel behind a button, or with `tip` a short hint on a thing. Tooltip and preview are both a Popover. */
// The kind is fixed where the Popover is written (`tip` or a panel), so it is chosen once.
export const Popover = (props: PopoverProps) => ("tip" in props ? <Tip {...props} /> : <Panel {...props} />);
