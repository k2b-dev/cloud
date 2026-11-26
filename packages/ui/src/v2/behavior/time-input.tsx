/**
 * Time input behaviour for v2: a time of day as segments, hour and minute (and AM/PM on a 12-hour clock), each a
 * spinbutton. Typing digits, the arrows (Up and Down step, Left and Right move between segments), PageUp/PageDown,
 * Home/End, Backspace, paste, the locale's order and separators and the hour cycle are core's. No ui-sdk type crosses
 * this module's exports.
 */
import { timeInput as timeInputPrimitive } from "@ui-sdk/core/time-input";
import { splitProps } from "solid-js";
import { type PartProps, part, partId, type SlotComponent, slotComponent, usePrimitive } from "./adapter";

export type TimeInputOptions = {
  /** The time as `HH:MM` on the 24-hour clock, or `null` while empty or partly typed. */
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  /** The language of the separators and the segment names. Always pass it: without it core reads the page. */
  locale?: string;
  /** 24 for a clock of 24 hours, 12 for twelve hours with AM and PM. */
  hourCycle?: 12 | 24;
  disabled?: boolean;
};

/** One segment of the time, as the root's state lists it. */
export type TimeSegment = { key: string; type: string; text: string; empty: boolean; editable: boolean; label: string };

export type TimeInputParts = {
  /** The group of segments; a children function gets `segments`, in the locale's order. */
  Root: SlotComponent;
  /** A segment one types in (`segment`): an input with the role spinbutton. */
  Segment: SlotComponent;
  /** The text between segments (`segment`), hidden from assistive technology. */
  Literal: SlotComponent;
};

/** A time of day in minutes. */
export function useTimeInput(options: () => TimeInputOptions = () => ({})): TimeInputParts {
  const handle = usePrimitive(timeInputPrimitive, () => {
    const { onValueChange, ...given } = options();
    return {
      ...given,
      granularity: "minute",
      onValueChange: onValueChange && ((value: unknown) => onValueChange(typeof value === "string" ? value : null)),
    };
  });
  // Core finds a part by its `id` (or `value`); a segment has neither, so every segment would be the one part of the
  // last segment rendered, and the hour would show the minute. Each segment is its own part, keyed by its type.
  const base = partId();
  const segment =
    (tag: "input" | "span"): SlotComponent =>
    (props: PartProps) => {
      const [own, element] = splitProps(props, ["segment"]);
      const key = () => {
        const given = own.segment;
        return typeof given === "object" && given !== null && "key" in given ? String(given.key) : "";
      };
      return part(handle, "segment", () => ({ segment: own.segment, id: `${base}-${key()}` }), element, tag);
    };
  return {
    Root: slotComponent(handle, "root", "div"),
    Segment: segment("input"),
    Literal: segment("span"),
  };
}
