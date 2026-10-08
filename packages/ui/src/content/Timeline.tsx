import type { DateContext } from "@k2b/stdlib";
import { createEffect, createMemo, createSignal, createUniqueId, For, Index, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { Dynamic, isServer } from "solid-js/web";
import Dropdown from "../actions/Dropdown";
import { announce } from "../feedback/announce";
import { useDateConfigLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import {
  buildTimelineModel,
  parseTimelineTime,
  spanCss,
  spanPx,
  type TimelineEntry,
  type TimelineGroup,
  type TimelineItem,
  type TimelineItemEntry,
  type TimelineModel,
  type TimelineMoreEntry,
  type TimelineUnits,
  timelineDayKey,
  timelineHourOf,
} from "./timeline-model";

export type { TimelineColor, TimelineItem } from "./timeline-model";

export type TimelineController = {
  /** Scrolls a time into view; `start` (default) puts it near the start edge, `center` in the middle. */
  scrollToTime: (time: Date | string, options?: { align?: "start" | "center" }) => void;
  /** Scrolls the current time to the middle of the view. */
  scrollToNow: () => void;
};

export type TimelineProps = {
  items: readonly TimelineItem[];
  /** Start of the loaded range. The view starts here, so pass the first time the reader should see. */
  from: Date | string;
  /** End of the loaded range (exclusive). */
  to: Date | string;
  /** The current time. Without it the timeline uses the clock and moves the now line every 30 seconds. */
  now?: Date | string;
  /** Accessible name of the region. Defaults to "Timeline". */
  label?: string;
  /** stdlib date context: time zone and locale of days, hours, and folds. */
  dateConfig?: DateContext;
  /** Convenience override for `dateConfig.timeZone`. */
  timeZone?: string;
  /** Level of the per-day headings. Defaults to 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Opens an item, on click, Enter, or Space. */
  onActivate?: (item: TimelineItem) => void;
  /** Changes the checkbox of an item, on a click on the box or Space. Leave it out when the reader may not change it. */
  onToggle?: (item: TimelineItem, checked: boolean) => void;
  /** Called once when the reader nears the start, again after `from` changed. Extend `from` to load earlier days. */
  onLoadEarlier?: () => unknown;
  /** Called once when the reader nears the end, again after `to` changed. Extend `to` to load later days. */
  onLoadLater?: () => unknown;
  /** Marks the region busy, for example while a range loads. */
  busy?: boolean;
  controller?: (controller: TimelineController) => void;
  class?: string;
};

type Axis = "horizontal" | "vertical";

/** Unit sizes of the horizontal axis, as in the stylesheet; the server and the first render use them. */
const HORIZONTAL_UNITS: TimelineUnits = [54, 48, 160, 0, 0];
/** How far beyond the visible area the first render reaches, in pixels. */
const INITIAL_REACH = 3200;
const COLOR_TOKENS = new Set(["blue", "emerald", "amber", "red", "violet", "cyan", "zinc"]);
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const colorAttributes = (color: string | undefined) =>
  color && HEX_COLOR.test(color)
    ? { token: undefined, accent: color }
    : { token: color && COLOR_TOKENS.has(color) ? color : "blue", accent: undefined };

const isAllDay = (entry: TimelineEntry) => entry.kind === "all-day" || (entry.kind === "more" && entry.area === "all-day");
const asItem = (entry: TimelineEntry): TimelineItemEntry | undefined => (entry.kind === "more" ? undefined : entry);
const asMore = (entry: TimelineEntry): TimelineMoreEntry | undefined => (entry.kind === "more" ? entry : undefined);

/** A scrollable ancestor in the block direction makes the page the primary scroll area, so the wheel stays native. */
const pageScrollsVertically = (from: Element): boolean => {
  for (let element = from.parentElement; element; element = element.parentElement) {
    if (element.scrollHeight <= element.clientHeight + 1) continue;
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === "auto" || overflow === "scroll" || element === document.scrollingElement) return true;
  }
  const root = document.scrollingElement;
  return Boolean(root && root.scrollHeight > root.clientHeight + 1);
};

/**
 * A continuous filmstrip of time: waking hours are proportional, nights and empty days fold, overlapping bands share
 * lanes. Wide containers show it horizontally, narrow ones vertically; both use the same model.
 */
export default function Timeline(props: TimelineProps): JSX.Element {
  const messages = useUiMessages();
  const context = useDateConfigLocale(() => ({ ...props.dateConfig, timeZone: props.timeZone ?? props.dateConfig?.timeZone }));
  const baseId = createUniqueId().replace(/[^a-zA-Z0-9_-]/g, "-");
  const [clock, setClock] = createSignal(Date.now());
  const now = createMemo(() => {
    const fixed = parseTimelineTime(props.now, context());
    return Number.isFinite(fixed) ? fixed : clock();
  });
  const today = createMemo(() => timelineDayKey(now(), context()));
  const model = createMemo<TimelineModel>(() =>
    buildTimelineModel({
      from: parseTimelineTime(props.from, context()),
      to: parseTimelineTime(props.to, context()),
      today: today(),
      items: props.items,
      context: context(),
    }),
  );
  const groupsByKey = createMemo(() => new Map(model().groups.map((group) => [group.key, group])));

  // Formatting.
  const locale = () => context().locale ?? "en";
  const timeFormat = createMemo(
    () => new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: context().timeZone }),
  );
  const formatTime = (time: number) => timeFormat().format(time);
  const dayFormat = createMemo(
    () => new Intl.DateTimeFormat(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: context().timeZone }),
  );
  const longDayFormat = createMemo(
    () => new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long", timeZone: context().timeZone }),
  );
  const hoursFormat = createMemo(
    () => new Intl.NumberFormat(locale(), { style: "unit", unit: "hour", unitDisplay: "short", maximumFractionDigits: 1 }),
  );
  const noonOf = (key: string) => new Date(timelineHourOf(key, 12, context()));
  const dayRange = (first: string, last: string, format: Intl.DateTimeFormat) =>
    first === last ? format.format(noonOf(first)) : `${format.format(noonOf(first))} – ${format.format(noonOf(last))}`;
  const nightLabel = createMemo(() => {
    const format = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
    return messages().timelineNight({ start: format.format(Date.UTC(2000, 0, 1, 22)), end: format.format(Date.UTC(2000, 0, 1, 6)) });
  });
  const spoken = (entry: TimelineItemEntry): string => {
    const item = entry.item;
    const parts = [item.label];
    if (entry.kind === "all-day") parts.push(messages().allDay);
    else if (entry.end > entry.start)
      parts.push(messages().timelineTimeRange({ start: formatTime(entry.start), end: formatTime(entry.end) }));
    else parts.push(formatTime(entry.start));
    if (item.detail) parts.push(item.detail);
    parts.push(
      entry.kind === "all-day" ? dayRange(entry.firstKey, entry.lastKey, longDayFormat()) : longDayFormat().format(new Date(entry.start)),
    );
    if (item.checked !== undefined) parts.push(item.checked ? messages().timelineDone : messages().timelineOpen);
    return parts.join(", ");
  };
  const isPast = (entry: TimelineEntry): boolean => {
    if (entry.kind === "more") return entry.hidden.every(isPast);
    if (entry.kind === "all-day") return entry.lastKey < today();
    return entry.end <= now();
  };

  // Layout of the axis the stylesheet chose, read from the viewport.
  let root: HTMLElement | undefined;
  let viewport: HTMLDivElement | undefined;
  let track: HTMLDivElement | undefined;
  const [layout, setLayout] = createSignal<{ axis: Axis; units: TimelineUnits }>({ axis: "horizontal", units: HORIZONTAL_UNITS });
  const readLayout = () => {
    if (!viewport) return layout();
    const style = getComputedStyle(viewport);
    const unit = (name: string) => Number.parseFloat(style.getPropertyValue(`--k2b-timeline-${name}`)) || 0;
    const units: TimelineUnits = [unit("hour"), unit("night"), unit("fold"), unit("head"), unit("row")];
    return {
      axis: style.getPropertyValue("--k2b-timeline-axis").trim() === "vertical" ? ("vertical" as const) : ("horizontal" as const),
      units: units.some((value) => value > 0) ? units : HORIZONTAL_UNITS,
    };
  };
  const px = (time: number) => spanPx(model().posOf(time), layout().units);

  /** The visible part of the track in its own pixels, clipped by the viewport and the window. */
  const visible = (): [number, number] => {
    if (!viewport || !track) return [0, INITIAL_REACH];
    const port = viewport.getBoundingClientRect();
    const box = track.getBoundingClientRect();
    const [portStart, portEnd, boxStart, limit] =
      layout().axis === "horizontal"
        ? [port.left, port.right, box.left, window.innerWidth]
        : [port.top, port.bottom, box.top, window.innerHeight];
    const start = Math.max(portStart, 0) - boxStart;
    return [start, Math.max(start, Math.min(portEnd, limit) - boxStart)];
  };
  const scrollBy = (delta: number, behavior: ScrollBehavior = "auto") => {
    if (!viewport || Math.abs(delta) < 0.5) return;
    const horizontal = layout().axis === "horizontal";
    const scrollable = horizontal ? viewport.scrollWidth > viewport.clientWidth : viewport.scrollHeight > viewport.clientHeight;
    if (scrollable) viewport.scrollBy({ [horizontal ? "left" : "top"]: delta, behavior });
    else if (!horizontal) window.scrollBy({ top: delta, behavior });
  };

  // Bounded rendering: groups whose reach meets the visible time range, widened by a screen, plus the focused group.
  const [range, setRange] = createSignal<[number, number]>();
  const shownRange = (): [number, number] => range() ?? [Number.NEGATIVE_INFINITY, model().timeAt(INITIAL_REACH, HORIZONTAL_UNITS)];
  const [active, setActive] = createSignal<string>();
  /** The item happening now or next. */
  const current = () => {
    const { order, entries } = model();
    return order.find((id) => {
      const entry = entries.get(id)!;
      return !isAllDay(entry) && entry.end >= now();
    });
  };
  const defaultActive = createMemo(() => current() ?? model().order.at(-1));
  const activeId = () => {
    const id = active();
    return id !== undefined && model().entries.has(id) ? id : defaultActive();
  };
  const renderedKeys = createMemo(() => {
    const [low, high] = shownRange();
    const focusGroup = model().entries.get(activeId() ?? "")?.group;
    return model()
      .groups.filter((group) => group.index === focusGroup || (group.reach[1] >= low && group.reach[0] <= high))
      .map((group) => group.key);
  });

  // Reading position: the time at the start edge, kept when days load or the axis changes.
  let anchor: { time: number; offset: number } | undefined;
  let requestedFrom: number | undefined;
  let requestedTo: number | undefined;
  let pendingEarlier = false;
  let pendingLater = false;
  const loadEdge = (edge: "earlier" | "later") => {
    const load = edge === "earlier" ? props.onLoadEarlier : props.onLoadLater;
    if (!load) return;
    const settle = () => {
      if (edge === "earlier") pendingEarlier = false;
      else pendingLater = false;
      queueMicrotask(refresh);
    };
    if (edge === "earlier") pendingEarlier = true;
    else pendingLater = true;
    Promise.resolve().then(load).then(settle, settle);
  };
  const refresh = () => {
    if (!viewport) return;
    const built = model();
    const { units } = layout();
    const [start, end] = visible();
    const reach = Math.max(end - start, 600);
    const time = built.timeAt(start, units);
    anchor = { time, offset: spanPx(built.posOf(time), units) - start };
    const [low, high] = range() ?? [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    if (built.timeAt(start - reach / 2, units) < low || built.timeAt(end + reach / 2, units) > high)
      setRange([built.timeAt(start - reach, units), built.timeAt(end + reach, units)]);
    const length = spanPx(built.total, units);
    if (start > reach) requestedFrom = undefined;
    else if (!pendingEarlier && requestedFrom !== built.from) {
      requestedFrom = built.from;
      loadEdge("earlier");
    }
    if (end < length - reach) requestedTo = undefined;
    else if (!pendingLater && requestedTo !== built.to) {
      requestedTo = built.to;
      loadEdge("later");
    }
  };
  const restore = () => {
    if (anchor) scrollBy(px(anchor.time) - anchor.offset - visible()[0]);
    refresh();
  };

  const scrollToTime = (time: number, align: "start" | "center" = "start") => {
    if (!viewport) return;
    const [start, end] = visible();
    const target = px(time) - (align === "center" ? (end - start) / 2 : 16);
    scrollBy(target - start, reducedMotion() ? "auto" : "smooth");
  };

  // Keyboard: one tab stop, moved by the keys of the axis.
  const elementOf = (id: string) =>
    [...(viewport?.querySelectorAll<HTMLElement>("[data-entry-id]") ?? [])].find((element) => element.dataset.entryId === id);
  const focusEntry = (id: string | undefined, message?: string) => {
    if (id === undefined) return;
    setActive(id);
    const element = elementOf(id);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    if (message) announce(message);
  };
  const groupLabel = (group: TimelineGroup) => dayRange(group.firstKey, group.lastKey, longDayFormat());
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest("[role='menu']") || event.altKey || event.ctrlKey || event.metaKey) return;
    const id = target.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
    const { order, entries, groups } = model();
    const index = id === undefined ? -1 : order.indexOf(id);
    const entry = id === undefined ? undefined : entries.get(id);
    const [back, forward] = layout().axis === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const key = event.key;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (key.toLowerCase() === "t") {
      handled();
      const happening = current();
      if (happening) focusEntry(happening);
      else scrollToTime(now(), "center");
      announce(messages().timelineNow({ time: formatTime(now()) }));
      return;
    }
    if (!entry) return;
    const group = groups[entry.group]!;
    if (key === back || key === forward) {
      handled();
      focusEntry(order[Math.max(0, Math.min(order.length - 1, index + (key === forward ? 1 : -1)))]);
    } else if (key === "PageDown" || key === "PageUp") {
      handled();
      const step = key === "PageDown" ? 1 : -1;
      for (let next = entry.group + step; next >= 0 && next < groups.length; next += step) {
        const first = groups[next]!.entries[0];
        if (first) return focusEntry(first.id, groupLabel(groups[next]!));
      }
    } else if (key === "Home" || key === "End") {
      handled();
      focusEntry((key === "Home" ? group.entries[0] : group.entries.at(-1))?.id);
    } else if (key === " " && entry.kind !== "more") {
      handled();
      if (props.onToggle && entry.item.checked !== undefined) props.onToggle(entry.item, !entry.item.checked);
      else if (props.onActivate) props.onActivate(entry.item);
      else if (entry.item.href) target.click();
    }
  };

  // The wheel scrolls a horizontal strip sideways only where nothing else scrolls vertically.
  let wheelTarget: number | undefined;
  let wheelFrame = 0;
  let primaryUntil = 0;
  let primary = false;
  const onWheel = (event: WheelEvent) => {
    if (!viewport || layout().axis !== "horizontal" || event.ctrlKey || event.shiftKey) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (performance.now() > primaryUntil) {
      primary = !pageScrollsVertically(viewport);
      primaryUntil = performance.now() + 500;
    }
    if (!primary) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? viewport.clientWidth : 1;
    const limit = viewport.scrollWidth - viewport.clientWidth;
    wheelTarget = Math.max(0, Math.min(limit, (wheelTarget ?? viewport.scrollLeft) + event.deltaY * scale));
    if (reducedMotion()) {
      viewport.scrollLeft = wheelTarget;
      wheelTarget = undefined;
      return;
    }
    if (wheelFrame) return;
    const step = () => {
      if (!viewport || wheelTarget === undefined) return;
      const distance = wheelTarget - viewport.scrollLeft;
      if (Math.abs(distance) < 1) {
        viewport.scrollLeft = wheelTarget;
        wheelTarget = undefined;
        wheelFrame = 0;
        return;
      }
      viewport.scrollLeft += distance * 0.35;
      wheelFrame = requestAnimationFrame(step);
    };
    wheelFrame = requestAnimationFrame(step);
  };

  const activate = (event: MouseEvent, entry: TimelineItemEntry) => {
    const onBox = (event.target as Element | null)?.closest(".k2b-timeline__check");
    if (onBox && props.onToggle && entry.item.checked !== undefined) {
      event.preventDefault();
      props.onToggle(entry.item, !entry.item.checked);
      return;
    }
    // A modified click on a link keeps its browser meaning, such as opening a new tab.
    if (!props.onActivate || (entry.item.href && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey))) return;
    event.preventDefault();
    props.onActivate(entry.item);
  };

  // Loading days at either end keeps what the reader sees in place.
  createEffect(on(model, restore, { defer: true }));

  onMount(() => {
    if (isServer || !viewport || !root) return;
    setLayout(readLayout());
    refresh();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    const onScroll = () => {
      // The anchor follows every scroll at once, so a load right after it keeps the latest position.
      const [start] = visible();
      const time = model().timeAt(start, layout().units);
      anchor = { time, offset: px(time) - start };
      schedule();
    };
    const resize = new ResizeObserver(() => {
      const next = readLayout();
      const previous = layout();
      if (next.axis !== previous.axis || next.units.some((value, index) => value !== previous.units[index])) {
        setLayout(next);
        if (anchor) anchor = { time: anchor.time, offset: 0 };
        restore();
      } else schedule();
    });
    resize.observe(viewport);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    const timer = props.now === undefined ? setInterval(() => setClock(Date.now()), 30_000) : undefined;
    onCleanup(() => {
      resize.disconnect();
      viewport?.removeEventListener("scroll", onScroll);
      viewport?.removeEventListener("wheel", onWheel);
      root?.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", schedule, { capture: true });
      cancelAnimationFrame(frame);
      cancelAnimationFrame(wheelFrame);
      if (timer) clearInterval(timer);
    });
    props.controller?.({
      scrollToTime: (time, options) => scrollToTime(parseTimelineTime(time, context()), options?.align),
      scrollToNow: () => scrollToTime(now(), "center"),
    });
  });

  const nowShown = () => now() >= model().from && now() < model().to;

  const Heading = (headingProps: { group: TimelineGroup }) => (
    <Dynamic
      component={`h${props.headingLevel ?? 3}`}
      id={`${baseId}-${headingProps.group.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
      class="k2b-timeline__heading"
    >
      <Show when={headingProps.group.today}>
        <span class="k2b-timeline__today">{messages().today}</span>
      </Show>
      <span class="k2b-timeline__day">{dayRange(headingProps.group.firstKey, headingProps.group.lastKey, dayFormat())}</span>
    </Dynamic>
  );

  const ItemControl = (itemProps: { entry: TimelineItemEntry }) => {
    const entry = () => itemProps.entry;
    const name = createMemo(() => spoken(entry()));
    const time = () => {
      const current = entry();
      if (current.kind === "all-day") return "";
      if (current.kind !== "folded" && current.end > current.start) return `${formatTime(current.start)}–${formatTime(current.end)}`;
      return formatTime(current.start);
    };
    return (
      <Dynamic
        component={entry().item.href ? "a" : "button"}
        type={entry().item.href ? undefined : "button"}
        href={entry().item.href}
        class="k2b-timeline__item"
        data-entry-id={entry().id}
        tabindex={activeId() === entry().id ? 0 : -1}
        aria-label={name()}
        title={name()}
        onClick={(event: MouseEvent) => activate(event, entry())}
      >
        <Show when={entry().item.checked !== undefined}>
          <span class="k2b-timeline__check" data-checked={entry().item.checked ? "true" : undefined} aria-hidden="true">
            <i class="ti ti-check" />
          </span>
        </Show>
        <span class="k2b-timeline__text">
          <span class="k2b-timeline__label">{entry().item.label}</span>
          <Show when={time()}>
            <span class="k2b-timeline__time">{time()}</span>
          </Show>
          <Show when={entry().item.detail}>
            <span class="k2b-timeline__detail">{entry().item.detail}</span>
          </Show>
        </span>
      </Dynamic>
    );
  };

  const MoreControl = (moreProps: { entry: TimelineMoreEntry }) => {
    const entry = () => moreProps.entry;
    const label = () => {
      const current = entry();
      const count = messages().timelineMore({ count: current.hidden.length });
      return current.area === "band"
        ? `${count}, ${messages().timelineTimeRange({ start: formatTime(current.start), end: formatTime(current.end) })}`
        : count;
    };
    const items = () =>
      entry().hidden.map((hidden) => {
        const time = `${formatTime(hidden.start)}–${formatTime(hidden.end)}`;
        const base = { label: hidden.item.label, description: hidden.item.detail ? `${time}, ${hidden.item.detail}` : time };
        if (props.onActivate) return { ...base, action: () => props.onActivate?.(hidden.item) };
        if (hidden.item.href) return { ...base, href: hidden.item.href };
        return { ...base, disabled: true as const };
      });
    return (
      <Dropdown.Root items={items()} label={label()} class="k2b-timeline__more-root">
        <Dropdown.Trigger
          appearance="plain"
          class="k2b-timeline__item k2b-timeline__more"
          data-entry-id={entry().id}
          tabIndex={activeId() === entry().id ? 0 : -1}
          label={label()}
          title={label()}
        >
          +{entry().hidden.length}
        </Dropdown.Trigger>
      </Dropdown.Root>
    );
  };

  const Slot = (slotProps: { id: string }) => {
    const entry = createMemo<TimelineEntry>(
      (previous) => model().entries.get(slotProps.id) ?? previous,
      model().entries.get(slotProps.id)!,
    );
    const color = () => {
      const current = entry();
      return colorAttributes(current.kind === "more" ? undefined : current.item.color);
    };
    const span = () => {
      const current = entry();
      if (current.kind !== "band") return undefined;
      const minutes = (current.end - current.start) / 60_000;
      return minutes < 30 ? "xs" : minutes < 60 ? "s" : minutes < 120 ? "m" : "l";
    };
    return (
      <li
        class="k2b-timeline__slot"
        data-kind={entry().kind}
        data-area={asMore(entry())?.area}
        data-past={isPast(entry()) ? "true" : undefined}
        data-span={span()}
        data-color={color().token}
        style={{
          "--k2b-timeline-at": spanCss(entry().at),
          "--k2b-timeline-size": spanCss(entry().size),
          "--k2b-timeline-lane": String(entry().lane),
          "--k2b-timeline-lanes": String(entry().lanes),
          "--k2b-timeline-accent": color().accent,
        }}
      >
        <Show when={asMore(entry())} fallback={<ItemControl entry={asItem(entry())!} />}>
          {(more) => <MoreControl entry={more()} />}
        </Show>
      </li>
    );
  };

  const Group = (groupProps: { key: string }) => {
    const group = createMemo<TimelineGroup>(
      (previous) => groupsByKey().get(groupProps.key) ?? previous,
      groupsByKey().get(groupProps.key)!,
    );
    const headingId = () => `${baseId}-${group().key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    return (
      <div
        class="k2b-timeline__group"
        data-kind={group().kind}
        data-today={group().today ? "true" : undefined}
        data-past={group().past ? "true" : undefined}
        data-row={group().row ? "true" : undefined}
        style={{ "--k2b-timeline-at": spanCss(group().at), "--k2b-timeline-size": spanCss(group().size) }}
      >
        <Heading group={group()} />
        <div class="k2b-timeline__decor" aria-hidden="true">
          <Index each={group().folds}>
            {(fold) => (
              <div
                class="k2b-timeline__fold"
                data-kind={fold().kind}
                style={{ "--k2b-timeline-at": spanCss(fold().at), "--k2b-timeline-size": spanCss(fold().size) }}
              >
                <i class="ti ti-moon" />
                <span class="k2b-timeline__fold-label">{fold().kind === "night" ? nightLabel() : messages().timelineNothingPlanned}</span>
              </div>
            )}
          </Index>
          <Index each={group().hours}>
            {(hour) => (
              <span class="k2b-timeline__hour" style={{ "--k2b-timeline-at": spanCss(hour().at) }}>
                <span class="k2b-timeline__hour-label">{formatTime(hour().time)}</span>
              </span>
            )}
          </Index>
          <Index each={group().gaps}>
            {(gap) => (
              <span
                class="k2b-timeline__gap"
                data-long={gap().long ? "true" : undefined}
                data-past={gap().end <= now() ? "true" : undefined}
                style={{ "--k2b-timeline-at": spanCss(gap().at) }}
              >
                {messages().timelineFree({ duration: hoursFormat().format(gap().hours) })}
              </span>
            )}
          </Index>
          <Index each={group().echoes}>
            {(echo) => {
              const color = () => {
                const current = echo();
                return colorAttributes(current.kind === "more" ? undefined : current.item.color);
              };
              return (
                // A pointer shortcut to an item that the keyboard and screen readers reach on the day it starts.
                // biome-ignore lint/a11y/noStaticElementInteractions: hidden from assistive technology on purpose.
                // biome-ignore lint/a11y/useKeyWithClickEvents: the item itself is the keyboard target.
                <span
                  class="k2b-timeline__echo"
                  data-color={color().token}
                  data-past={isPast(echo()) ? "true" : undefined}
                  style={{ "--k2b-timeline-lane": String(echo().lane), "--k2b-timeline-accent": color().accent }}
                  onClick={() => elementOf(echo().id)?.click()}
                >
                  {asItem(echo())?.item.label ?? `+${asMore(echo())?.hidden.length ?? 0}`}
                </span>
              );
            }}
          </Index>
        </div>
        <Show when={group().entries.length > 0}>
          <ol class="k2b-timeline__list" aria-labelledby={headingId()}>
            <For each={group().entries.map((entry) => entry.id)}>{(id) => <Slot id={id} />}</For>
          </ol>
        </Show>
      </div>
    );
  };

  return (
    <section
      ref={root}
      class={`k2b-timeline ${props.class ?? ""}`}
      aria-label={props.label ?? messages().timeline}
      aria-describedby={`${baseId}-hint`}
      aria-busy={props.busy ? "true" : undefined}
      onFocusIn={(event) => {
        const id = (event.target as HTMLElement).closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
        if (id !== undefined) setActive(id);
      }}
    >
      <div ref={viewport} class="k2b-timeline__viewport" tabIndex={model().order.length === 0 ? 0 : undefined}>
        <div ref={track} class="k2b-timeline__track" style={{ "--k2b-timeline-length": spanCss(model().total) }}>
          <For each={renderedKeys()}>{(key) => <Group key={key} />}</For>
          <div
            class="k2b-timeline__now"
            aria-hidden="true"
            data-hidden={nowShown() ? undefined : "true"}
            style={{ "--k2b-timeline-at": spanCss(model().posOf(now())) }}
          >
            <span class="k2b-timeline__now-time">{formatTime(now())}</span>
          </div>
        </div>
      </div>
      <span id={`${baseId}-hint`} class="k2b-sr-only">
        {messages().timelineHint}
      </span>
    </section>
  );
}
