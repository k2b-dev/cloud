/**
 * Disclosure for v2, one core primitive through the adapter: open and closed with Enter, Space and the find-in-page of
 * a closed panel from core's `collapsible`. In a module of its own, so a page that folds something and picks a file
 * only later keeps the file picker out of its first chunk. No ui-sdk type crosses these exports.
 */
import { collapsible } from "@ui-sdk/core/collapsible";
import { type SlotComponent, slotComponent, usePrimitive } from "./adapter";

export type DisclosureOptions = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export type DisclosureParts = {
  Root: SlotComponent;
  /** The button that opens and closes the panel; it says whether the panel is open. */
  Trigger: SlotComponent;
  /** The panel; pass `hiddenUntilFound` so find-in-page reaches a closed one. */
  Panel: SlotComponent;
};

export function useDisclosure(options: () => DisclosureOptions): DisclosureParts {
  const handle = usePrimitive(collapsible, options);
  return {
    Root: slotComponent(handle, "root", "div"),
    Trigger: slotComponent(handle, "trigger", "button"),
    Panel: slotComponent(handle, "panel", "div"),
  };
}
