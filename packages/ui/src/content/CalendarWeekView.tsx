import { dates as calendar } from "@k2b/stdlib";
import {
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import type { CalendarEvent } from "./Calendar";
import { GESTURE_GAP_MS, snapToColumn, type WheelAxis, wheelAxis, wheelDelta, wheelPixels } from "./calendar-day-scroll";
import {
  addDayKeys,
  DAY_MINUTES,
  type DaySpan,
  dayHeightTerms,
  dayKeyNumber,
  dayKeyRange,
  dayMinuteAt,
  dayY,
  dayYTerms,
  readDayGeometry,
  termsCss,
} from "./calendar-days";
import { layoutMonthWeek } from "./calendar-month-layout";
import { startCalendarPointerSession } from "./calendar-pointer";
import { EventChip, eventHref, followCalendarHref, textWidth } from "./calendar-shared";
import {
  createTimeView,
  dayBands,
  dayGaps,
  dayLoad,
  eventAccent,
  foldedEntries,
  gapAside,
  isNearNow,
  longDay,
  markerAbove,
  nightHours,
  reducedMotion,
  swallowNextClick,
  TimeBand,
  TimeCheck,
  TimeGap,
  TimeMarker,
  TimeOverlays,
  TimeQuickCreate,
  type TimeView,
  type TimeViewHandle,
  type TimeViewProps,
  weekKeysOf,
} from "./calendar-time-view";

/** Room a bar keeps beside its title and date hint: padding, torn edge, gap, and an icon such as a task box. */
const HINT_SLACK_PX = 36;

/**
 * The week view with `dayHours`: the loaded days side by side in one strip, seven on a wide screen and three on a
 * phone. A trackpad, Shift with the wheel, or a finger scroll it sideways day by day; each gesture keeps the axis it
 * started on, and the strip settles on a day start. The arrows move by whole weeks.
 */
export const CalendarWeekView = (props: TimeViewProps) => {
  const view = createTimeView(props);
  const [mounted, setMounted] = createSignal(false);
  const [firstIndex, setFirstIndex] = createSignal(0);
  const [visibleCount, setVisibleCount] = createSignal(7);
  /** The week whose nights decide whether the night rows open, set by navigation, not by free scrolling. */
  const [nightWeek, setNightWeek] = createSignal(untrack(view.anchorKey));
  const [nightOverride, setNightOverride] = createSignal<boolean | null>(null);
  const [roving, setRoving] = createSignal("");
  let scroller: HTMLDivElement | undefined;
  const helpId = createUniqueId();

  const anchorWeek = () => weekKeysOf(view, view.anchorKey());
  // The server and the first render draw only the shown week, so the strip never flashes the days before it.
  const keys = createMemo(() => {
    const { first, last } = view.range();
    if (mounted()) return dayKeyRange(first, last);
    const week = anchorWeek();
    return week[0]! >= first && week[6]! <= last ? week : dayKeyRange(first, last);
  });
  const indexOf = (key: string) => dayKeyNumber(key) - dayKeyNumber(keys()[0]!);
  const nightsOpen = createMemo(() => {
    const override = nightOverride();
    if (override !== null) return override;
    return weekKeysOf(view, nightWeek()).some((key) => view.dayOf(key).night);
  });
  createEffect(on(nightWeek, () => setNightOverride(null), { defer: true }));
  const wake = () => view.wake();

  // Columns and scrolling.
  /** The exact width of a day column: columns are a seventh or a third of the strip, rarely whole pixels. */
  const columnWidth = () => scroller?.querySelector<HTMLElement>("[data-calendar-column]")?.getBoundingClientRect().width ?? 0;
  const gutterWidth = () => scroller?.querySelector<HTMLElement>(".k2b-calendar-week__gutter")?.offsetWidth ?? 0;
  const leftOf = (index: number) => index * columnWidth();
  const visibleIndex = () => {
    const width = columnWidth();
    return width > 0 && scroller ? Math.round(scroller.scrollLeft / width) : 0;
  };
  const visibleKeys = () => {
    const first = keys()[Math.min(keys().length - 1, Math.max(0, firstIndex()))] ?? view.anchorKey();
    return { first, last: addDayKeys(first, visibleCount() - 1) };
  };
  /** Now shows in the hours while today is among the days in view, like the prototype's week. */
  const nowShown = () => {
    const { first, last } = visibleKeys();
    const today = view.nowKey();
    return today >= first && today <= last && view.nowMinute() >= 0 && view.nowMinute() < (nightsOpen() ? DAY_MINUTES : wake());
  };

  let settling = false;
  let glideTarget: number | null = null;
  let glideTimer = 0;
  const glideTo = (left: number, top?: number) => {
    if (!scroller) return;
    const target = Math.max(0, Math.min(left, scroller.scrollWidth - scroller.clientWidth));
    glideTarget = target;
    window.clearTimeout(glideTimer);
    glideTimer = window.setTimeout(() => {
      glideTarget = null;
    }, 1600);
    scroller.scrollTo({ left: target, ...(top === undefined ? {} : { top }), behavior: reducedMotion() ? "instant" : "smooth" });
  };
  /** The scroll position of a minute in the timeline, with now in the upper third. */
  const topFor = (minute: number) => {
    if (!scroller) return 0;
    const body = scroller.querySelector<HTMLElement>("[data-calendar-body]");
    const head = scroller.querySelector<HTMLElement>(".k2b-calendar-week__top");
    if (!body || !head) return 0;
    const geometry = readDayGeometry(body, wake(), nightsOpen());
    const offset = body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - head.offsetHeight;
    return Math.max(0, offset + dayY(geometry, minute) - (scroller.clientHeight - head.offsetHeight) / 3);
  };
  /** The first column of a week: its first day, or on a phone a day of it kept inside the week. */
  const columnFor = (key: string, phoneDay?: string) => {
    const week = weekKeysOf(view, key);
    if (visibleCount() >= 7 || !phoneDay) return indexOf(week[0]!);
    const day = Math.max(0, Math.min(7 - visibleCount(), dayKeyNumber(phoneDay) - dayKeyNumber(week[0]!)));
    return indexOf(week[day]!);
  };
  const positionAt = (key: string) => {
    if (!scroller) return;
    measureCount();
    const today = view.nowKey();
    const inWeek = weekKeysOf(view, key).includes(today);
    scroller.scrollLeft = leftOf(columnFor(key, inWeek ? today : key));
    scroller.scrollTop = inWeek ? topFor(view.nowMinute()) : topFor(60);
    lastLeft = scroller.scrollLeft;
    syncFirst();
  };
  const measureCount = () => {
    const width = columnWidth();
    if (!scroller || width <= 0) return;
    // Whole-pixel columns leave a few pixels at the right edge; the strip ends at its last whole day instead of
    // showing a sliver of the next one.
    const room = scroller.clientWidth + (Number.parseFloat(scroller.style.marginRight) || 0) - gutterWidth();
    const count = Math.max(1, Math.round(room / width));
    setVisibleCount(count);
    const rest = Math.floor(room - count * width);
    scroller.style.marginRight = rest > 0 ? `${rest}px` : "";
  };
  let reportTimer = 0;
  let reported = "";
  const syncFirst = () => {
    const index = visibleIndex();
    if (index !== untrack(firstIndex)) setFirstIndex(index);
    if (!untrack(keys)[index]) return;
    // The host learns the days the reader sees once they changed, after the scroll calmed down.
    const { first, last } = untrack(visibleKeys);
    if (`${first}/${last}` === reported) return;
    reported = `${first}/${last}`;
    window.clearTimeout(reportTimer);
    reportTimer = window.setTimeout(() => props.owner.onVisibleDateChange?.(view.parseKey(first), view.parseKey(last)), 250);
  };

  // A gesture keeps its axis; the strip settles on a day start once the scroll rests.
  let axis: WheelAxis | null = null;
  let lastWheel = 0;
  let fingers = 0;
  let restTimer = 0;
  let ready = false;
  const settle = () => {
    if (!scroller || fingers > 0 || settling || glideTarget !== null || view.dragging()) return;
    const width = columnWidth();
    const target = snapToColumn(scroller.scrollLeft, width);
    if (Math.abs(target - scroller.scrollLeft) <= 0.5) return;
    settling = true;
    scroller.scrollTo({ left: target, behavior: reducedMotion() ? "instant" : "smooth" });
    window.setTimeout(() => {
      settling = false;
    }, 450);
  };
  const onWheel = (event: WheelEvent) => {
    if (!scroller || event.ctrlKey || view.dragging()) return;
    // A gesture that goes on takes over from a glide onto a day start; the strip settles again once it rests.
    settling = false;
    if (event.timeStamp - lastWheel > GESTURE_GAP_MS || axis === null) axis = wheelAxis(event.deltaX, event.deltaY, event.shiftKey);
    lastWheel = event.timeStamp;
    const delta = wheelPixels(
      wheelDelta(axis, event.deltaX, event.deltaY, event.shiftKey),
      event.deltaMode,
      axis === "x" ? scroller.clientWidth : scroller.clientHeight,
    );
    if (axis === "x") {
      event.preventDefault();
      glideTarget = null;
      scroller.scrollLeft += delta;
    } else if (event.deltaX !== 0) {
      // A trackpad's slight sideways drift in a vertical gesture would move the days; only the vertical part counts.
      event.preventDefault();
      scroller.scrollTop += delta;
    }
  };
  let askedEarlier = "";
  let askedLater = "";
  /** The last scroll position the strip read, to tell which way the reader moves. */
  let lastLeft = 0;
  /**
   * Asks for the week before or after once the reader moves within a week of an end. Days loaded before the strip push
   * it on by a week, so only moving toward an end asks; a glide may load later days, which push nothing.
   */
  const loadMore = () => {
    if (!scroller || !ready || view.dragging()) return;
    const width = columnWidth();
    const { first, last } = view.range();
    const left = scroller.scrollLeft;
    const direction = Math.sign(left - lastLeft);
    lastLeft = left;
    if (direction < 0 && glideTarget === null && left < width * 7 - 1 && props.owner.onLoadEarlier && askedEarlier !== first) {
      askedEarlier = first;
      void props.owner.onLoadEarlier();
    }
    if (
      direction > 0 &&
      left + scroller.clientWidth > scroller.scrollWidth - width * 7 + 1 &&
      props.owner.onLoadLater &&
      askedLater !== last
    ) {
      askedLater = last;
      void props.owner.onLoadLater();
    }
  };
  let frame = 0;
  const onScroll = () => {
    if (!scroller) return;
    if (glideTarget !== null && Math.abs(scroller.scrollLeft - glideTarget) < 2) glideTarget = null;
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncFirst();
        loadMore();
        rememberAnchor();
      });
    window.clearTimeout(restTimer);
    restTimer = window.setTimeout(settle, fingers > 0 ? 160 : 140);
  };

  // Days loaded before the strip's first day shift it; the view keeps its days in place.
  let anchor: { key: string; offset: number } | null = null;
  /** Notes the day at the start of the strip, read against the days the strip draws, which may still be the old ones. */
  const rememberAnchor = (drawn = untrack(keys)) => {
    if (!scroller) return;
    const width = columnWidth();
    if (width <= 0) return;
    const index = Math.floor(scroller.scrollLeft / width);
    const key = drawn[index];
    if (key) anchor = { key, offset: scroller.scrollLeft - index * width };
  };
  // Before the days change the strip, note its place from the page as it stands. A computation runs before any render
  // effect touches the page, so no row has shrunk the strip yet.
  createComputed(
    on(
      keys,
      (next, drawn) => {
        if (!untrack(mounted) || !drawn) return;
        rememberAnchor(drawn);
        // Days that come in before the strip move every index; the first day in view stays the same day, so what
        // depends on the days in view, such as the all-day row, never sees the days that came in.
        const shift = dayKeyNumber(drawn[0]!) - dayKeyNumber(next[0]!);
        if (shift !== 0) setFirstIndex((index) => index + shift);
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      keys,
      () => {
        if (!untrack(mounted) || !scroller || !anchor) return;
        const index = indexOf(anchor.key);
        const left = leftOf(index) + anchor.offset;
        if (Math.abs(scroller.scrollLeft - left) > 0.5) scroller.scrollLeft = left;
        lastLeft = scroller.scrollLeft;
      },
      { defer: true },
    ),
  );

  onMount(() => {
    setMounted(true);
    queueMicrotask(() => {
      positionAt(view.anchorKey());
      rememberAnchor();
      ready = true;
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            const before = untrack(firstIndex);
            measureCount();
            if (!scroller) return;
            scroller.scrollLeft = leftOf(before);
            lastLeft = scroller.scrollLeft;
            syncFirst();
          });
    if (scroller) observer?.observe(scroller);
    onCleanup(() => {
      observer?.disconnect();
      window.clearTimeout(restTimer);
      window.clearTimeout(reportTimer);
      window.clearTimeout(glideTimer);
      if (frame) cancelAnimationFrame(frame);
    });
  });
  createEffect(
    on(
      view.anchorKey,
      (key) => {
        if (!untrack(mounted)) return;
        setNightWeek(key);
        queueMicrotask(() => {
          positionAt(key);
          rememberAnchor();
        });
      },
      { defer: true },
    ),
  );

  const loaded = (key: string) => key >= view.range().first && key <= view.range().last;
  const handle: TimeViewHandle = {
    visibleKeys,
    step: (direction) => {
      const first = visibleKeys().first;
      const week = weekKeysOf(view, first);
      // From the middle of a week the arrows go to the start of a week first.
      const target = direction > 0 ? addDayKeys(week[0]!, 7) : first === week[0] ? addDayKeys(week[0]!, -7) : week[0]!;
      const last = addDayKeys(target, Math.min(6, visibleCount() - 1));
      if (!loaded(target) || !loaded(last)) return false;
      setNightWeek(target);
      glideTo(leftOf(indexOf(target)));
      return true;
    },
    goTo: (key) => {
      if (!loaded(key)) return false;
      setNightWeek(key);
      view.setSelection({ key });
      glideTo(leftOf(columnFor(key, key)));
      return true;
    },
    today: () => {
      const today = view.nowKey();
      const week = weekKeysOf(view, today);
      if (!loaded(week[0]!) || !loaded(week[6]!)) return false;
      setNightWeek(today);
      queueMicrotask(() => glideTo(leftOf(columnFor(today, today)), topFor(view.nowMinute())));
      return true;
    },
    todayDirection: () => {
      const today = view.nowKey();
      const { first, last } = visibleKeys();
      if (today < first) return "left";
      if (today > last) return "right";
      return "";
    },
    controller: {
      quickCreate: (create) => {
        const target = view.createTarget(visibleKeys());
        const column = scroller?.querySelector<HTMLElement>(`[data-calendar-body="${target.key}"]`);
        view.openQuickCreate(
          target.key,
          target.start,
          target.end,
          slotRect(target.key, target.start, target.end) ?? column ?? scroller!,
          create,
        );
      },
      createTarget: () => view.rangeOfSelection(view.createTarget(visibleKeys())),
      dragIn: (event, item, onDrop) => view.dragIn(event, item, onDrop, scroller),
    },
  };
  const slotRect = (key: string, start: number, end: number): DOMRect | null => {
    const body = scroller?.querySelector<HTMLElement>(`[data-calendar-body="${key}"]`);
    if (!body || !scroller) return null;
    const rect = body.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    if (rect.right < bounds.left + gutterWidth() || rect.left > bounds.right) return null;
    const geometry = readDayGeometry(body, wake(), nightsOpen());
    const top = rect.top + dayY(geometry, start);
    const bottom = rect.top + dayY(geometry, end);
    if (bottom < bounds.top + 40 || top > bounds.bottom - 20) return null;
    return new DOMRect(
      rect.left,
      Math.max(bounds.top, top),
      rect.width,
      Math.max(8, Math.min(bottom, bounds.bottom) - Math.max(bounds.top, top)),
    );
  };
  onMount(() => props.register(handle));
  onCleanup(() => props.register(null));

  // The all-day row: one bar per week, with a torn edge where an event goes on in the week before or after.
  const allDay = createMemo(() => {
    const all = keys();
    const spans = new Map<CalendarEvent, DaySpan<CalendarEvent>>();
    for (const key of all) for (const span of view.dayOf(key).spans) spans.set(span.item, span);
    const entries = [...spans.values()]
      .sort((left, right) => left.firstKey.localeCompare(right.firstKey) || right.lastKey.localeCompare(left.lastKey))
      .map((span) => ({ item: span, firstKey: span.firstKey, lastKey: span.lastKey, bar: !span.marker }));
    const weeks: { offset: number; keys: string[] }[] = [];
    for (let index = 0; index < all.length; ) {
      const week = weekKeysOf(view, all[index]!).filter((key) => key >= all[0]! && key <= all[all.length - 1]!);
      const offset = indexOf(week[0]!);
      weeks.push({ offset, keys: week });
      index = offset + week.length;
    }
    return weeks.map((week) => {
      const layout = layoutMonthWeek(week.keys, entries);
      const lanes = Math.max(0, ...layout.bars.map((bar) => bar.lane + 1));
      return { ...week, layout, rows: lanes + Math.max(0, ...layout.singles.map((singles) => singles.length)) };
    });
  });
  /**
   * The rows the weeks in view need, as in a week of its own. A week that loads off screen never changes them, so the
   * hours stay where they are; its entries below these rows wait hidden until it comes into view.
   */
  const allDayRows = createMemo(() => {
    const first = firstIndex();
    const last = first + visibleCount() - 1;
    return Math.max(
      1,
      ...allDay()
        .filter((week) => week.offset <= last && week.offset + week.keys.length - 1 >= first)
        .map((week) => week.rows),
    );
  });

  // Keyboard: one tab stop in the grid; the arrows move between days, entries, and free time. Only what is drawn can
  // take the focus.
  const stops = () =>
    [...(scroller?.querySelectorAll<HTMLElement>("[data-stop]") ?? [])].filter((stop) => stop.getClientRects().length > 0);
  const focusDayKey = () => {
    const current = view.selection()?.key;
    const { first, last } = visibleKeys();
    if (current && current >= first && current <= last) return current;
    return view.nowKey() >= first && view.nowKey() <= last ? view.nowKey() : first;
  };
  const rovingId = () => roving() || `h:${focusDayKey()}`;
  const tabOf = (id: string) => (rovingId() === id ? 0 : -1);
  const onKeyDown = (event: KeyboardEvent) => {
    const current = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-stop]") : null;
    if (!current || event.altKey || event.metaKey || event.ctrlKey) return;
    const direction = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Home: "home", End: "end" }[event.key];
    if (!direction) return;
    event.preventDefault();
    const all = stops();
    const column = Number(current.dataset.col);
    const minute = Number(current.dataset.minute);
    const inColumn = (index: number) =>
      all
        .filter((stop) => Number(stop.dataset.col) === index)
        .sort((left, right) => Number(left.dataset.minute) - Number(right.dataset.minute));
    const list = inColumn(column);
    const position = list.indexOf(current);
    let next: HTMLElement | undefined;
    if (direction === "down") next = list[position + 1];
    else if (direction === "up") next = list[position - 1];
    else if (direction === "home") next = list[0];
    else if (direction === "end") next = list[list.length - 1];
    else {
      const other = inColumn(column + (direction === "left" ? -1 : 1));
      next = other.reduce<HTMLElement | undefined>(
        (best, stop) =>
          Math.abs(Number(stop.dataset.minute) - minute) < Math.abs(Number(best?.dataset.minute ?? Number.POSITIVE_INFINITY) - minute)
            ? stop
            : best,
        undefined,
      );
    }
    if (!next) return;
    setRoving(next.dataset.stop ?? "");
    next.focus({ preventScroll: Boolean(next.closest(".k2b-calendar-week__top")) });
    const index = Number(next.dataset.col);
    const first = untrack(firstIndex);
    if (index < first) glideTo(leftOf(index));
    else if (index >= first + visibleCount()) glideTo(leftOf(index - visibleCount() + 1));
  };

  const openDay = (key: string) => {
    const href = props.owner.views && !props.owner.views.includes("day") ? undefined : props.owner.getDateHref?.(view.parseKey(key), "day");
    if (href) followCalendarHref(props.owner, href);
    else {
      props.owner.onViewChange?.("day");
      props.owner.onDateChange?.(view.parseKey(key), "day");
    }
  };
  let lastPointer = "mouse";

  // The all-day row: drag across days for one all-day event; a double-click creates on one day.
  const startAllDayRange = (pointerEvent: PointerEvent, row: HTMLElement) => {
    if (pointerEvent.pointerType !== "mouse" || pointerEvent.button !== 0 || !view.canCreate()) return;
    const keyAt = (clientX: number) => {
      const width = columnWidth();
      const rect = row.getBoundingClientRect();
      const index = Math.max(0, Math.min(keys().length - 1, Math.floor((clientX - rect.left) / width)));
      return keys()[index]!;
    };
    const origin = keyAt(pointerEvent.clientX);
    startCalendarPointerSession({
      event: pointerEvent,
      resolve: (clientX) => keyAt(clientX),
      onPreview: (key) => setRangeSelection(origin < key ? { first: origin, last: key } : { first: key, last: origin }),
      onCommit: (key) => {
        swallowNextClick();
        const range = origin < key ? { first: origin, last: key } : { first: key, last: origin };
        const cells = scroller?.querySelector<HTMLElement>(".k2b-calendar-week__range");
        setRangeSelection(null);
        const start = view.parseKey(range.first);
        const end = calendar.addDays(view.parseKey(range.last), 1, view.dateConfig());
        if (props.owner.renderQuickCreate)
          view.setQuick({ range: { start, end, allDay: true }, anchor: cells?.getBoundingClientRect() ?? row, key: range.first });
        else props.owner.onSlotActivate?.({ start, end, allDay: true });
      },
      onCancel: () => setRangeSelection(null),
    });
  };
  const [rangeSelection, setRangeSelection] = createSignal<{ first: string; last: string } | null>(null);

  return (
    <div class="k2b-calendar-week" data-view="week" data-dragging={view.dragging() || undefined}>
      <div
        ref={scroller}
        class="k2b-calendar-week__scroll"
        role="group"
        aria-label={view.messages().calendarWeek}
        aria-describedby={helpId}
        onScroll={onScroll}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        onFocusIn={(event) => {
          const stop = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-stop]") : null;
          if (stop?.dataset.stop) setRoving(stop.dataset.stop);
        }}
        onTouchStart={(event) => {
          fingers = event.touches.length;
          glideTarget = null;
        }}
        onTouchEnd={(event) => {
          fingers = event.touches.length;
          onScroll();
        }}
        onTouchCancel={(event) => {
          fingers = event.touches.length;
        }}
        style={{ "--k2b-calendar-days": String(keys().length) }}
      >
        <div class="k2b-calendar-week__grid">
          <div class="k2b-calendar-week__top">
            <div class="k2b-calendar-week__corner" aria-hidden="true">
              {view.messages().calendarWeekNumber({ week: isoWeek(visibleKeys().first) })}
            </div>
            <For each={keys()}>
              {(key) => {
                const today = () => key === view.calendarToday();
                const selected = () => {
                  const current = view.selection();
                  return Boolean(current && current.key === key && current.start === undefined);
                };
                const badge = () => props.owner.dayBadges?.[key];
                const load = () => dayLoad(view, key);
                const date = () => view.parseKey(key);
                return (
                  <button
                    type="button"
                    class="k2b-calendar-week__head"
                    data-calendar-head={key}
                    data-stop={`h:${key}`}
                    data-col={indexOf(key)}
                    data-minute={-2}
                    tabIndex={tabOf(`h:${key}`)}
                    aria-pressed={selected() ? "true" : "false"}
                    aria-label={[longDay(view, key), today() ? view.props.labels.today : "", badge()?.label ?? ""]
                      .filter(Boolean)
                      .join(", ")}
                    data-today={today() ? "true" : undefined}
                    data-past={key < view.calendarToday() ? "true" : undefined}
                    style={{ "grid-column": String(indexOf(key) + 2) }}
                    onPointerDown={(event) => {
                      lastPointer = event.pointerType;
                      // The heading stays on top: focusing it must not scroll the grid.
                      if (event.button === 0) {
                        event.preventDefault();
                        event.currentTarget.focus({ preventScroll: true });
                      }
                    }}
                    onClick={(event) => {
                      if (event.detail >= 2 || (selected() && lastPointer !== "mouse")) {
                        openDay(key);
                        return;
                      }
                      view.setTouchDraft(null);
                      view.setSelection(selected() ? null : { key });
                    }}
                  >
                    <span class="k2b-calendar-week__weekday">
                      {date()
                        .toLocaleDateString(view.dateConfig().locale ?? "en", { weekday: "short", timeZone: view.dateConfig().timeZone })
                        .replace(/\.$/, "")}
                    </span>
                    <span class="k2b-calendar-week__number">{calendar.formatDayNumber(date(), view.dateConfig())}</span>
                    <span class="k2b-calendar-week__extra">
                      <Show when={badge()}>
                        {(current) => (
                          <span class="k2b-calendar-week__badge">
                            <Show when={current().icon}>{(icon) => <i class={`ti ti-${icon()}`} aria-hidden="true" />}</Show>
                            {current().label}
                          </span>
                        )}
                      </Show>
                    </span>
                    <span class="k2b-calendar-week__load" aria-hidden="true">
                      <For each={load()}>
                        {(piece) => <span style={{ width: `${((piece.end - piece.start) / wake()) * 100}%`, background: piece.color }} />}
                      </For>
                    </span>
                  </button>
                );
              }}
            </For>
            <div class="k2b-calendar-week__all-day-label" aria-hidden="true">
              <span class="k2b-calendar-week__all-day-long">{view.messages().calendarAllDayRow}</span>
              <span class="k2b-calendar-week__all-day-short">{view.messages().calendarAllDayRowShort}</span>
            </div>
            <div
              class="k2b-calendar-week__all-day"
              role="group"
              aria-label={view.messages().calendarAllDayAndDue}
              style={{ "grid-template-rows": `repeat(${allDayRows()}, var(--k2b-calendar-all-day-row))` }}
              onPointerDown={(event) => {
                if (event.target instanceof Element && event.target.closest("a,button,[data-calendar-event]")) return;
                startAllDayRange(event, event.currentTarget);
              }}
              onDblClick={(event) => {
                if (!(event.target instanceof Element) || event.target.closest("a,button,[data-calendar-event]")) return;
                const width = columnWidth();
                const rect = event.currentTarget.getBoundingClientRect();
                const key = keys()[Math.max(0, Math.min(keys().length - 1, Math.floor((event.clientX - rect.left) / width)))]!;
                const start = view.parseKey(key);
                const range = { start, end: calendar.addDays(start, 1, view.dateConfig()), allDay: true };
                if (props.owner.renderQuickCreate)
                  view.setQuick({ range, anchor: new DOMRect(rect.left + indexOf(key) * width, rect.top, width, rect.height), key });
                else props.owner.onSlotActivate?.(range);
              }}
            >
              <Show when={rangeSelection()}>
                {(range) => (
                  <div
                    class="k2b-calendar-week__range"
                    style={{ "grid-column": `${indexOf(range().first) + 1} / ${indexOf(range().last) + 2}`, "grid-row": "1 / -1" }}
                    aria-hidden="true"
                  />
                )}
              </Show>
              <For each={allDay()}>
                {(week) => (
                  <>
                    <For each={week.layout.bars}>
                      {(bar) => {
                        const span = bar.endColumn - bar.startColumn + 1;
                        const event = bar.item.item;
                        const hint = (target: string, kind: "from" | "until", before = "") => {
                          const text =
                            kind === "from"
                              ? view.messages().calendarContinuesFrom(hintDate(view, target, visibleKeys().first))
                              : view.messages().calendarContinuesUntil(hintDate(view, target, visibleKeys().first));
                          const font = `600 11px ${typeof document === "undefined" ? "sans-serif" : getComputedStyle(document.body).fontFamily}`;
                          return textWidth(`${event.title}${before}`, font) + textWidth(text, font) + HINT_SLACK_PX <=
                            span * columnWidthSignal()
                            ? text
                            : undefined;
                        };
                        const start = () => (bar.continuesBefore ? hint(bar.item.firstKey, "from") : undefined);
                        const end = () => (bar.continuesAfter ? hint(bar.item.lastKey, "until", start() ?? "") : undefined);
                        return (
                          <div
                            class="k2b-calendar-week__slot"
                            style={{
                              "grid-column": `${week.offset + bar.startColumn + 1} / ${week.offset + bar.endColumn + 2}`,
                              "grid-row": String(bar.lane + 1),
                              display: bar.lane + 1 > allDayRows() ? "none" : undefined,
                            }}
                          >
                            <EventChip
                              event={view.normalized(event, bar.item.firstKey)}
                              owner={props.owner}
                              href={eventHref(props.owner, event)}
                              label={spanLabel(view, bar.item)}
                              compact
                              timeline
                              bar
                              continuesBefore={bar.continuesBefore}
                              continuesAfter={bar.continuesAfter}
                              hintStart={start()}
                              hintEnd={end()}
                              tabIndex={tabOf(`a:${event.id}:${week.offset}`)}
                              stop={{
                                id: `a:${event.id}:${week.offset}`,
                                column: week.offset + bar.startColumn,
                                minute: -1 + bar.lane / 100,
                              }}
                            />
                          </div>
                        );
                      }}
                    </For>
                    <For each={week.layout.singles}>
                      {(singles, column) => {
                        const lanes = () =>
                          Math.max(
                            0,
                            ...week.layout.bars
                              .filter((bar) => bar.startColumn <= column() && bar.endColumn >= column())
                              .map((bar) => bar.lane + 1),
                          );
                        return (
                          <For each={singles}>
                            {(span, row) => {
                              const event = span.item;
                              const checked = () => view.checkedOf(event);
                              const id = `a:${event.id}:${week.offset}`;
                              return (
                                <div
                                  class="k2b-calendar-week__slot"
                                  data-checkbox={checked() !== undefined ? "true" : undefined}
                                  data-checked={checked() ? "true" : undefined}
                                  data-just-checked={view.justChecked().has(event.id) ? "true" : undefined}
                                  style={{
                                    "grid-column": String(week.offset + column() + 1),
                                    "grid-row": String(lanes() + row() + 1),
                                    "--k2b-calendar-accent": eventAccent(event),
                                    display: lanes() + row() + 1 > allDayRows() ? "none" : undefined,
                                  }}
                                >
                                  <Show when={checked() !== undefined}>
                                    <TimeCheck view={view} event={event} tabIndex={-1} />
                                  </Show>
                                  <EventChip
                                    event={view.normalized(event, span.firstKey)}
                                    owner={props.owner}
                                    href={eventHref(props.owner, event)}
                                    compact
                                    timeline
                                    checkbox={checked() !== undefined}
                                    onCheck={view.checkOf(event)}
                                    tabIndex={tabOf(id)}
                                    stop={{ id, column: week.offset + column(), minute: -1 + (lanes() + row()) / 100 }}
                                  />
                                </div>
                              );
                            }}
                          </For>
                        );
                      }}
                    </For>
                  </>
                )}
              </For>
            </div>
          </div>
          <div class="k2b-calendar-week__body" style={{ height: termsCss(dayHeightTerms(wake(), nightsOpen())) }}>
            <div class="k2b-calendar-week__gutter">
              <For each={Array.from({ length: wake() / 60 + 1 }, (_, index) => index * 60)}>
                {(minute) => (
                  <span
                    class="k2b-calendar-week__hour"
                    data-near-now={nowShown() && isNearNow(view, view.nowKey(), minute) ? "true" : undefined}
                    style={{ top: termsCss(dayYTerms(wake(), nightsOpen(), minute)) }}
                    aria-hidden="true"
                  >
                    {view.clock(minute)}
                  </span>
                )}
              </For>
              <Show when={nightsOpen()}>
                <For each={nightHours(wake())}>
                  {(minute) => (
                    <span
                      class="k2b-calendar-week__hour"
                      data-night="true"
                      style={{ top: termsCss(dayYTerms(wake(), true, minute)) }}
                      aria-hidden="true"
                    >
                      {view.clock(minute)}
                    </span>
                  )}
                </For>
              </Show>
              <button
                type="button"
                class="k2b-calendar-week__moon"
                aria-expanded={nightsOpen() ? "true" : "false"}
                aria-label={
                  nightsOpen()
                    ? view.messages().calendarFoldNights
                    : view.messages().calendarOpenNights({ from: view.clock(wake()).slice(0, 2), to: view.clock(DAY_MINUTES).slice(0, 2) })
                }
                title={
                  nightsOpen()
                    ? view.messages().calendarFoldNights
                    : view.messages().calendarOpenNights({ from: view.clock(wake()).slice(0, 2), to: view.clock(DAY_MINUTES).slice(0, 2) })
                }
                data-open={nightsOpen() ? "true" : undefined}
                style={{ top: termsCss(dayYTerms(wake(), nightsOpen(), nightsOpen() ? wake() : wake() + 1)) }}
                onClick={() => setNightOverride(!nightsOpen())}
              >
                <i class="ti ti-moon" aria-hidden="true" />
                <i class={`ti ${nightsOpen() ? "ti-chevron-up" : "ti-chevron-down"}`} aria-hidden="true" />
              </button>
              <Show when={nowShown()}>
                <span
                  class="k2b-calendar-week__now-time"
                  style={{ top: termsCss(dayYTerms(wake(), nightsOpen(), view.nowMinute())) }}
                  aria-hidden="true"
                >
                  {view.clock(view.nowMinute())}
                </span>
              </Show>
            </div>
            <div class="k2b-calendar-week__lines" aria-hidden="true">
              <For each={Array.from({ length: wake() / 60 + 1 }, (_, index) => index * 60)}>
                {(minute) => <span class="k2b-calendar-week__line" style={{ top: termsCss(dayYTerms(wake(), nightsOpen(), minute)) }} />}
              </For>
              <Show
                when={nightsOpen()}
                fallback={
                  <span class="k2b-calendar-week__fold" style={{ top: `calc(${termsCss(dayYTerms(wake(), false, wake()))} + 3px)` }} />
                }
              >
                <span
                  class="k2b-calendar-night"
                  style={{ top: termsCss(dayYTerms(wake(), true, wake())), height: termsCss([0, (DAY_MINUTES - wake()) / 60, 1, 0]) }}
                />
                <For each={nightHours(wake())}>
                  {(minute) => (
                    <span
                      class="k2b-calendar-week__line"
                      data-midnight={view.clock(minute) === "00:00" ? "true" : undefined}
                      style={{ top: termsCss(dayYTerms(wake(), true, minute)) }}
                    />
                  )}
                </For>
              </Show>
              <Show when={nowShown()}>
                <span class="k2b-calendar-week__now-line" style={{ top: termsCss(dayYTerms(wake(), nightsOpen(), view.nowMinute())) }} />
              </Show>
            </div>
            <For each={keys()}>
              {(key) => (
                <WeekColumn
                  view={view}
                  dayKey={key}
                  column={indexOf(key)}
                  expanded={nightsOpen()}
                  tabOf={tabOf}
                  lastPointer={() => lastPointer}
                  setLastPointer={(value) => {
                    lastPointer = value;
                  }}
                  scroller={() => scroller}
                />
              )}
            </For>
          </div>
        </div>
      </div>
      <p class="k2b-calendar-sr" id={helpId}>
        {view.messages().calendarKeyboardHelp}
      </p>
      <TimeQuickCreate view={view} />
    </div>
  );

  function columnWidthSignal() {
    // Read through the visible count so a resize recomputes the hints.
    visibleCount();
    return columnWidth();
  }
};

const WeekColumn = (props: {
  view: TimeView;
  dayKey: string;
  column: number;
  expanded: boolean;
  tabOf: (id: string) => number;
  lastPointer: () => string;
  setLastPointer: (value: string) => void;
  scroller: () => HTMLElement | undefined;
}) => {
  const view = props.view;
  const model = createMemo(() => view.dayOf(props.dayKey));
  const wake = () => view.wake();
  const bands = createMemo(() => dayBands(view, props.dayKey, props.expanded));
  const gaps = createMemo(() => dayGaps(view, props.dayKey));
  const markers = () => model().markers.filter((marker) => marker.minute < (props.expanded ? DAY_MINUTES : wake()));
  const folded = () => (props.expanded ? [] : foldedEntries(view, props.dayKey));
  const isEmptyTarget = (target: EventTarget | null) =>
    target instanceof Element &&
    !target.closest(
      "a,button,[data-calendar-event],.k2b-calendar-band,.k2b-calendar-marker,.k2b-calendar-draft,.k2b-calendar-week__fold-cell",
    );
  const minuteAt = (element: HTMLElement, clientY: number) => {
    const geometry = readDayGeometry(element, wake(), props.expanded);
    return Math.max(
      0,
      Math.min((props.expanded ? DAY_MINUTES : wake()) - 15, dayMinuteAt(geometry, clientY - element.getBoundingClientRect().top)),
    );
  };
  const nowMinute = () => (props.dayKey === view.nowKey() ? view.nowMinute() : null);
  const selected = () => view.selection()?.key === props.dayKey;
  const timeline = createMemo(() =>
    [
      ...gaps().map((gap) => ({ at: gap.start, kind: "gap" as const, gap })),
      ...bands().map((band) => ({ at: Math.max(0, band.start), kind: "band" as const, band })),
      ...markers().map((marker) => ({ at: marker.minute, kind: "marker" as const, marker })),
    ].sort((left, right) => left.at - right.at),
  );
  return (
    <div
      ref={(element) => view.registerBody(props.dayKey, element, () => props.expanded)}
      class="k2b-calendar-week__column"
      data-calendar-column=""
      data-calendar-body={props.dayKey}
      data-expanded={props.expanded ? "true" : "false"}
      data-today={props.dayKey === view.calendarToday() ? "true" : undefined}
      data-selected={selected() ? "true" : undefined}
      data-active={view.activeKey() === props.dayKey ? "true" : undefined}
      role="group"
      aria-label={longDay(view, props.dayKey)}
      style={{ "grid-column": String(props.column + 2), height: termsCss(dayHeightTerms(wake(), props.expanded)) }}
      onPointerDown={(event) => {
        props.setLastPointer(event.pointerType);
        if (event.button !== 0 || !isEmptyTarget(event.target)) return;
        view.startDraw(event, props.dayKey, props.scroller());
      }}
      // Some engines send a tap as touch events only; a tap is a tap either way.
      onTouchStart={() => props.setLastPointer("touch")}
      // Listening on the column itself, not through delegation, makes it a tap target on iOS.
      on:click={(event) => {
        if (!isEmptyTarget(event.target)) return;
        const minute = Math.floor(minuteAt(event.currentTarget, event.clientY) / 30) * 30;
        const end = Math.min(minute + 60, props.expanded ? DAY_MINUTES : wake());
        if (props.lastPointer() === "mouse") {
          if (!view.canCreate()) return;
          view.setTouchDraft(null);
          view.setSelection({ key: props.dayKey, start: minute, end });
          return;
        }
        // A first tap on a column shows its free time; the next one proposes an hour there.
        if (view.activeKey() !== props.dayKey) {
          view.setActiveKey(props.dayKey);
          view.setTouchDraft(null);
          view.setSelection({ key: props.dayKey });
          return;
        }
        if (!view.canCreate()) return;
        view.setTouchDraft({ key: props.dayKey, start: minute, end });
        view.setSelection({ key: props.dayKey, start: minute, end });
      }}
      onDblClick={(event) => {
        if (!isEmptyTarget(event.target) || props.lastPointer() !== "mouse") return;
        const minute = Math.floor(minuteAt(event.currentTarget, event.clientY) / 30) * 30;
        view.openQuickCreate(props.dayKey, minute, Math.min(minute + 60, props.expanded ? DAY_MINUTES : wake()), event.currentTarget);
      }}
    >
      <For each={timeline()}>
        {(entry) =>
          entry.kind === "gap" ? (
            <TimeGap
              view={view}
              gap={entry.gap}
              dayKey={props.dayKey}
              expanded={props.expanded}
              aside={gapAside(model(), entry.gap)}
              tabIndex={props.tabOf(`g:${props.dayKey}:${entry.gap.start}`)}
              stop={{ id: `g:${props.dayKey}:${entry.gap.start}`, column: props.column, minute: entry.gap.start + 0.5 }}
            />
          ) : entry.kind === "band" ? (
            <TimeBand
              view={view}
              band={entry.band}
              dayKey={props.dayKey}
              expanded={props.expanded}
              hourPx={48}
              tabIndex={props.tabOf(`b:${entry.band.item.id}:${props.dayKey}`)}
              stop={{ id: `b:${entry.band.item.id}:${props.dayKey}`, column: props.column, minute: entry.band.start }}
              scroller={props.scroller}
            />
          ) : (
            <TimeMarker
              view={view}
              event={entry.marker.item}
              minute={entry.marker.minute}
              dayKey={props.dayKey}
              expanded={props.expanded}
              above={markerAbove(model(), entry.marker.minute)}
              showTime={false}
              tabIndex={props.tabOf(`m:${entry.marker.item.id}`)}
              stop={{ id: `m:${entry.marker.item.id}`, column: props.column, minute: entry.marker.minute }}
              scroller={props.scroller}
            />
          )
        }
      </For>
      <Show when={!props.expanded && folded().length > 0}>
        <div class="k2b-calendar-week__fold-cell" style={{ top: `calc(${termsCss(dayYTerms(wake(), false, wake()))} + 3px)` }}>
          <ul class="k2b-calendar-fold__chips">
            <For each={folded()}>
              {(entry) => (
                <li>
                  <EventChip
                    event={view.normalized(entry.event, props.dayKey)}
                    owner={view.props.owner}
                    href={eventHref(view.props.owner, entry.event)}
                    compact
                    timeline
                    leadingTime={entry.time}
                    tabIndex={-1}
                  />
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
      <TimeOverlays view={view} dayKey={props.dayKey} expanded={props.expanded} />
      <Show when={nowMinute() !== null && nowMinute()! >= 0 && nowMinute()! < (props.expanded ? DAY_MINUTES : wake())}>
        <div class="k2b-calendar-now" style={{ top: termsCss(dayYTerms(wake(), props.expanded, nowMinute()!)) }} aria-hidden="true" />
      </Show>
    </div>
  );
};

/** ISO week number of a day key. */
const isoWeek = (key: string) => {
  const date = new Date(`${key}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
};

/** The day at a torn end of a bar, with its month when it lies in another month than the shown week. */
const hintDate = (view: TimeView, target: string, shown: string) => ({
  day: Number(target.slice(8, 10)),
  month:
    target.slice(0, 7) === shown.slice(0, 7)
      ? undefined
      : view
          .parseKey(target)
          .toLocaleDateString(view.dateConfig().locale ?? "en", { month: "short", timeZone: view.dateConfig().timeZone })
          .replace(/\.$/, ""),
});

/** A long entry's accessible name names the days it spans. */
const spanLabel = (view: TimeView, span: DaySpan<CalendarEvent>) => {
  if (span.firstKey === span.lastKey) return undefined;
  const format = (key: string) =>
    view
      .parseKey(key)
      .toLocaleDateString(view.dateConfig().locale ?? "en", { month: "long", day: "numeric", timeZone: view.dateConfig().timeZone });
  return view.messages().calendarEventTime({ title: span.item.title, start: format(span.firstKey), end: format(span.lastKey) });
};
