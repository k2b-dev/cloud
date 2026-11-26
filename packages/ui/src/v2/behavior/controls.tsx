/**
 * Tabs behaviour for v2, one core primitive through the adapter: roving focus and activation. The v2 primitives add
 * structure and look; no ui-sdk type crosses these exports. (Tooltips are `useTip`; checkboxes and switches are native
 * inputs in the v2 controls.)
 */
import { tabs as tabsPrimitive } from "@ui-sdk/core/tabs";
import { type SlotComponent, slotComponent, usePrimitive } from "./adapter";

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
