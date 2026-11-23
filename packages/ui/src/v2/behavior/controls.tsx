/**
 * Tabs, Tooltip, Checkbox and Switch behaviour for v2, each one core primitive through the adapter: roving focus and
 * activation for tabs, hover and focus delays for the tooltip, checked state (with `mixed`) and the form input for
 * checkbox and switch. The v2 primitives add structure and look; no ui-sdk type crosses these exports.
 */
import { checkbox as checkboxPrimitive } from "@ui-sdk/core/checkbox";
import { switchPrimitive } from "@ui-sdk/core/switch";
import { tabs as tabsPrimitive } from "@ui-sdk/core/tabs";
import { tooltip as tooltipPrimitive } from "@ui-sdk/core/tooltip";
import type { JSX } from "solid-js";
import { type PartProps, part, popupComponent, type SlotComponent, slotComponent, usePrimitive } from "./adapter";

export type TabsParts = {
  List: SlotComponent;
  /** One tab; `value` names it, a panel with the same `value` belongs to it. */
  Tab: SlotComponent;
  Panel: SlotComponent;
};

/** Tabs: arrows, Home and End move between tabs; `activation: "manual"` waits for Enter or Space. */
export function useTabs(
  options: () => {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    orientation?: "horizontal" | "vertical";
    activation?: "automatic" | "manual";
  },
): TabsParts {
  const handle = usePrimitive(tabsPrimitive, options);
  return {
    List: slotComponent(handle, "list", "div"),
    Tab: slotComponent(handle, "tab", "button"),
    Panel: slotComponent(handle, "panel", "div"),
  };
}

export type TooltipParts = {
  /** The element the tooltip describes. */
  Trigger: SlotComponent;
  /** The tooltip; shown after the delay on hover and at once on keyboard focus. Takes `side`, `align`, `sideOffset`. */
  Popup: SlotComponent;
};

/** A tooltip that names or describes its trigger; Escape hides it. */
export function useTooltip(
  options: () => { delay?: number; closeDelay?: number; open?: boolean; onOpenChange?: (open: boolean) => void } = () => ({}),
): TooltipParts {
  const handle = usePrimitive(tooltipPrimitive, options);
  return {
    Trigger: slotComponent(handle, "trigger", "button"),
    Popup: popupComponent(handle, "content"),
  };
}

type CheckOptions = {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
};

export type CheckParts = {
  /** The control and its hidden form input. */
  Root: (props: PartProps) => JSX.Element;
  /** The mark of a checked box, or the thumb of a switch. */
  Mark: SlotComponent;
};

/** A checkbox: Space toggles; `checked: "mixed"` is not part of this first cut. */
export function useCheckbox(options: () => CheckOptions): CheckParts {
  const handle = usePrimitive(checkboxPrimitive, options);
  return {
    Root: (props) => (
      <>
        {part(handle, "root", undefined, props, "button")}
        {part(handle, "input", undefined, {}, "input")}
      </>
    ),
    Mark: slotComponent(handle, "indicator", "span"),
  };
}

/** A switch: Space and Enter toggle. */
export function useSwitch(options: () => CheckOptions): CheckParts {
  const handle = usePrimitive(switchPrimitive, options);
  return {
    Root: (props) => (
      <>
        {part(handle, "root", undefined, props, "button")}
        {part(handle, "input", undefined, {}, "input")}
      </>
    ),
    Mark: slotComponent(handle, "thumb", "span"),
  };
}
