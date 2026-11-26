/**
 * Time input behaviour for v2: a time of day as segments, hour and minute (and AM/PM on a 12-hour clock), each a
 * spinbutton. Typing digits, the arrows (Up and Down step, Left and Right move between segments), PageUp/PageDown,
 * Home/End, Backspace, the locale's order and separators and the hour cycle are core's. Two things are glue here: a
 * pasted time is read in the forms people write it (core takes only "14:30"), and an empty segment is named in the
 * locale's words (core says "Empty"). No ui-sdk type crosses this module's exports.
 */
import { timeInput as timeInputPrimitive } from "@ui-sdk/core/time-input";
import { mergeProps, onCleanup, splitProps } from "solid-js";
import { type PartProps, part, partId, type SlotComponent, slotComponent, usePrimitive } from "./adapter";
import { readTime } from "./time-text";

export type TimeInputOptions = {
  /** The time as `HH:MM` on the 24-hour clock, or `null` while empty or partly typed. */
  value?: string | null;
  onValueChange?: (value: string | null) => void;
  /** The language of the separators and the segment names. Always pass it: without it core reads the page. */
  locale?: string;
  /** 24 for a clock of 24 hours, 12 for twelve hours with AM and PM. */
  hourCycle?: 12 | 24;
  disabled?: boolean;
  /** What an empty segment is called to assistive technology, in the locale ("leer"). */
  emptyText?: string;
  /** A paste that is no time: nothing changes, and the field says so. */
  onUnreadable?: () => void;
  /** A paste that was read, also one of the time the field already holds (core reports no change then). */
  onRead?: () => void;
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
    const { onValueChange, emptyText: _, onUnreadable: __, onRead: ___, ...given } = options();
    return {
      ...given,
      granularity: "minute",
      onValueChange: onValueChange && ((value: unknown) => onValueChange(typeof value === "string" ? value : null)),
    };
  });
  /** Pasted text in any form people write a time: read here, handed to core as `HH:MM`, or refused visibly. */
  const pasted = (event: ClipboardEvent) => {
    event.preventDefault();
    const given = options();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    // an empty clipboard is no answer to anything: nothing changes, nothing is said
    if (!text.trim()) return;
    const hhmm = readTime(text, given.locale ?? "en");
    if (hhmm === undefined) {
      given.onUnreadable?.();
      return;
    }
    handle.api.setValue(hhmm, { reason: "paste", event });
    given.onRead?.();
  };
  /**
   * Core writes an empty segment's `aria-valuetext` ("Empty") to the element itself, after any attribute of ours; the
   * locale's word replaces it there, each time core writes it.
   */
  const localizeEmpty = (element: HTMLElement) => {
    const fix = () => {
      // only a real change is written: an equal value would still be a mutation, and the observer would call itself
      // for ever (in English the locale's word is "Empty" too)
      const empty = options().emptyText;
      if (empty && empty !== "Empty" && element.getAttribute("aria-valuetext") === "Empty") element.setAttribute("aria-valuetext", empty);
    };
    fix();
    const observer = new MutationObserver(fix);
    observer.observe(element, { attributes: true, attributeFilter: ["aria-valuetext"] });
    onCleanup(() => observer.disconnect());
  };
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
      const user =
        tag === "input"
          ? mergeProps(element, {
              onPaste: pasted,
              ref: (el: HTMLElement) => {
                localizeEmpty(el);
                element.ref?.(el);
              },
            })
          : element;
      return part(handle, "segment", () => ({ segment: own.segment, id: `${base}-${key()}` }), user, tag);
    };
  return {
    Root: slotComponent(handle, "root", "div"),
    Segment: segment("input"),
    Literal: segment("span"),
  };
}
