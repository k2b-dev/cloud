/**
 * Tabs and rating behaviour for v2, each one core primitive through the adapter: roving focus and activation. The v2
 * primitives add structure and look; no ui-sdk type crosses these exports. (Tooltips are `useTip`; checkboxes and
 * switches are native inputs in the v2 controls.)
 */
import { rating as ratingPrimitive } from "@ui-sdk/core/rating";
import { tabs as tabsPrimitive } from "@ui-sdk/core/tabs";
import { mergeProps } from "solid-js";
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

export type RatingOptions = {
  /** The score held by the caller; `null` before anyone rates. */
  value?: number | null;
  /** The score at first, when the rating keeps it itself; a form's reset returns to it. */
  defaultValue?: number | null;
  onValueChange?: (value: number | null) => void;
  /** How many stars: 5 when not set. */
  max?: number;
  /** Shows a given score (any score, such as an average of 4.2) as one picture that cannot be changed. */
  readOnly?: boolean;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  /** The words of a score, for each star and for a read-only rating, in the page's language. */
  getValueLabel?: (value: number, max: number) => string;
};

export type RatingParts = {
  /** The group (a radio group, or one picture when read-only). */
  Root: SlotComponent;
  /** One star; `index` from 1. Its fill (0 to 1) is `--rating-fill`, `data-filled` when whole. */
  Item: SlotComponent;
  /** The radio of a star, over it; `value` is its score as text. Enter on a star not chosen yet chooses it. */
  Radio: SlotComponent;
  /** The hidden native radio of a star that a form sends, resets and checks; `value` as for `Radio`. */
  Input: SlotComponent;
};

/**
 * A star rating: one Tab stop, arrows move and choose, Space chooses, the form sends, resets and requires the score.
 * Core sends a form on Enter, as a native radio does; here Enter first chooses a star that is not chosen yet (the
 * first stop of a rating nobody has rated), and only on the chosen star sends the form.
 */
export function useRating(options: () => RatingOptions): RatingParts {
  const handle = usePrimitive(ratingPrimitive, options);
  const radio = slotComponent(handle, "radio", "button");
  return {
    Root: slotComponent(handle, "root", "div"),
    Item: slotComponent(handle, "item", "span"),
    Radio: (props) =>
      radio(
        mergeProps(props, {
          onKeyDown: (event: KeyboardEvent) => {
            const score = Number(props.value);
            if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey || handle.api.getValue() === score) return;
            event.preventDefault();
            handle.api.setValue(score, { reason: "item-press", event });
          },
        }),
      ),
    Input: slotComponent(handle, "input", "input"),
  };
}
