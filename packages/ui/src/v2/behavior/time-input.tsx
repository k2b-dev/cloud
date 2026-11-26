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

/** The words a locale gives morning and afternoon ("am", "pm"), lower case. */
const dayPeriods = (locale: string): [string, string] => {
  const format = new Intl.DateTimeFormat(locale, { hour: "numeric", hourCycle: "h12", timeZone: "UTC" });
  const period = (hour: number) =>
    format
      .formatToParts(Date.UTC(2000, 0, 1, hour))
      .find((each) => each.type === "dayPeriod")
      ?.value.toLowerCase() ?? "";
  return [period(1), period(13)];
};

/**
 * A pasted time as `HH:MM`, or `undefined` when it is none: "14:30", "1430", "9:30", "9.30", "9" and, with a day
 * period, "02:30 PM", "2:30pm" or "2:30 p" (in the locale's words or am/pm). A day period counts on a 12-hour clock
 * only.
 */
export const readPastedTime = (text: string, locale: string, hourCycle: 12 | 24): string | undefined => {
  const typed = text.trim().toLowerCase();
  const words = typed.replace(/[\d\s:.,h]/g, "");
  let afternoon = false;
  if (words) {
    if (hourCycle === 24) return undefined;
    const [am, pm] = dayPeriods(locale);
    afternoon = (pm !== "" && pm.startsWith(words)) || "pm".startsWith(words);
    const morning = !afternoon && ((am !== "" && am.startsWith(words)) || "am".startsWith(words));
    if (!afternoon && !morning) return undefined;
  }
  const groups = typed.match(/\d+/g) ?? [];
  const [first = "", second] = groups;
  if (groups.length > 2 || first.length > 4 || (second !== undefined && second.length > 2)) return undefined;
  const split = second === undefined && first.length > 2;
  let hour = Number(split ? first.slice(0, -2) : first);
  const minute = Number(split ? first.slice(-2) : (second ?? 0));
  if (!first) return undefined;
  if (words) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (afternoon ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

/** A time of day in minutes. */
export function useTimeInput(options: () => TimeInputOptions = () => ({})): TimeInputParts {
  const handle = usePrimitive(timeInputPrimitive, () => {
    const { onValueChange, emptyText: _, onUnreadable: __, ...given } = options();
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
    const hhmm = readPastedTime(text, given.locale ?? "en", given.hourCycle ?? 24);
    if (hhmm === undefined) given.onUnreadable?.();
    else handle.api.setValue(hhmm, { reason: "paste", event });
  };
  /**
   * Core writes an empty segment's `aria-valuetext` ("Empty") to the element itself, after any attribute of ours; the
   * locale's word replaces it there, each time core writes it.
   */
  const localizeEmpty = (element: HTMLElement) => {
    const fix = () => {
      const empty = options().emptyText;
      if (empty && element.getAttribute("aria-valuetext") === "Empty") element.setAttribute("aria-valuetext", empty);
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
