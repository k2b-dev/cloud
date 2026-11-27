/**
 * Tooltip behaviour for v2: the delay, the shared warm-up between neighbours, hover and keyboard focus, Escape, and
 * naming or describing the trigger are core's (`tooltip`). The trigger is an element someone else renders (a button),
 * so the tip binds to it instead of wrapping it. No ui-sdk type crosses this module's exports.
 */
import { tooltip as tooltipPrimitive } from "@ui-sdk/core/tooltip";
import { popupComponent, type SlotComponent, usePrimitive } from "./adapter";
import { bindSlot } from "./bind";

export type TipParts = {
  /**
   * Makes an element on the page the tip's trigger; returns the function that lets go of it. Many triggers may share
   * one tip: each passes its `payload`, which `onPayloadChange` hands on when it opens the tip.
   */
  bindTrigger: (element: HTMLElement, payload?: string) => () => void;
  /** The tip; core keeps it in the page so it names or describes its trigger. Takes `Placement` props. */
  Popup: SlotComponent;
};

let triggers = 0;

/**
 * `visual`: the tip only shows what its triggers already say in their own names (a day of a `Heat`), so it neither
 * names nor describes them; without it the tip names or describes its trigger, as a `Popover` tip does.
 */
export function useTip(options: () => { onPayloadChange?: (payload: unknown) => void } = () => ({}), mode?: "visual"): TipParts {
  const handle = usePrimitive(tooltipPrimitive, options);
  const omit = mode === "visual" ? ["aria-describedby", "aria-labelledby"] : [];
  return {
    bindTrigger: (element, payload) => {
      triggers += 1;
      return bindSlot(handle, "trigger", { id: `k2-tip-${triggers}`, ...(payload === undefined ? {} : { payload }) }, element, omit);
    },
    Popup: popupComponent(handle, "content"),
  };
}
