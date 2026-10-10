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
import { brakedScroll, GESTURE_GAP_MS, SETTLE_RADIUS, settleTarget, stopCrossing, stopIndexAt, wheelPixels } from "./calendar-day-scroll";
import {
  addDayKeys,
  DAY_MINUTES,
  type DayGroup,
  dayGroups,
  dayHeightTerms,
  dayKeyRange,
  dayMinuteAt,
  dayY,
  dayYTerms,
  readDayGeometry,
  termsCss,
} from "./calendar-days";
import { EventChip, eventHref } from "./calendar-shared";
import {
  AllDayChips,
  createTimeView,
  dayBands,
  dayGaps,
  daySummary,
  foldedEntries,
  gapAside,
  isNearNow,
  longDay,
  markerAbove,
  nightHours,
  reducedMotion,
  shortDay,
  soonNote,
  TimeBand,
  TimeGap,
  TimeMarker,
  TimeOverlays,
  TimeQuickCreate,
  type TimeView,
  type TimeViewHandle,
  type TimeViewProps,
} from "./calendar-time-view";

const groupId = (group: DayGroup) => (group.kind === "day" ? `d:${group.key}` : `e:${group.keys.join(",")}`);
const groupFirst = (group: DayGroup) => (group.kind === "day" ? group.key : group.keys[0]!);

/**
 * The day view with `dayHours`: the loaded days one below the other in a single scroll, each with its heading kept on
 * top while it is in view. Runs of empty days fold into one row. The view slows down and settles at each day start,
 * and a line at the top of the heading fills while a day start passes.
 */
export const CalendarDayView = (props: TimeViewProps) => {
  const view = createTimeView(props);
  const [mounted, setMounted] = createSignal(false);
  const [unfolded, setUnfolded] = createSignal<ReadonlySet<string>>(new Set());
  const [topKey, setTopKey] = createSignal(untrack(view.anchorKey));
  const [hover, setHover] = createSignal<{ key: string; minute: number } | null>(null);
  /** Where today's day lies from the view, kept current while scrolling for the Today button's arrow. */
  const [todayPlace, setTodayPlace] = createSignal<"up" | "down" | "">("");
  let scroller: HTMLDivElement | undefined;
  let track: HTMLDivElement | undefined;
  const helpId = createUniqueId();

  // The server and the first render start at the shown day, so the page never flashes the days before it; once
  // mounted the earlier days join above it without moving the view.
  const keys = createMemo(() => {
    const { first, last } = view.range();
    const anchor = view.anchorKey();
    const from = mounted() || anchor < first || anchor > last ? first : anchor;
    return dayKeyRange(from, last);
  });
  // Today and the day the reader opened never fold, so a day opened from the month shows its hours to create in.
  const groups = createMemo(() => dayGroups(keys(), (key) => view.dayOf(key).empty, [view.nowKey(), view.anchorKey()], unfolded()));
  const groupIds = createMemo(() => groups().map(groupId));
  const groupsById = createMemo(() => new Map(groups().map((group) => [groupId(group), group])));

  // Where each group starts in the scroll, measured after every change of the groups and on resize.
  let sections: HTMLElement[] = [];
  let tops: number[] = [];
  const measure = () => {
    if (!track) return;
    sections = [...track.querySelectorAll<HTMLElement>(":scope > [data-calendar-group]")];
    tops = sections.map((section) => section.offsetTop);
  };
  const keysOf = (section: HTMLElement | undefined) => (section?.dataset.calendarKeys ?? "").split(",").filter(Boolean);
  const sectionOf = (key: string) => sections.find((section) => keysOf(section).includes(key));

  /** The group at the top of the view and how far into it the view is, kept across changes above it. */
  let anchor: { key: string; delta: number } | null = null;
  /** The last scroll position the view read, to tell the reader's direction. */
  let lastScrollTop = 0;
  const rememberAnchor = () => {
    if (!scroller || sections.length === 0) return;
    const index = stopIndexAt(tops, scroller.scrollTop);
    const section = sections[index];
    if (section) anchor = { key: keysOf(section)[0]!, delta: scroller.scrollTop - tops[index]! };
  };
  const restoreAnchor = () => {
    if (!scroller || !anchor) return;
    const saved = anchor;
    let index = sections.findIndex((section) => keysOf(section).includes(saved.key));
    if (index < 0) index = sections.findIndex((section) => keysOf(section)[0]! >= saved.key);
    if (index < 0) return;
    const top = tops[index]! + Math.min(saved.delta, sections[index]!.offsetHeight - 1);
    if (Math.abs(scroller.scrollTop - top) > 0.5) scroller.scrollTop = top;
    lastScrollTop = scroller.scrollTop;
  };

  /** The scroll position of a minute of a day, or of the day's start without a minute. */
  const topFor = (key: string, minute?: number) => {
    const section = sectionOf(key);
    if (!section) return null;
    const index = sections.indexOf(section);
    const body = section.querySelector<HTMLElement>("[data-calendar-body]");
    if (minute === undefined || !body) return tops[index]!;
    const geometry = readDayGeometry(body, view.wake(), body.dataset.expanded === "true");
    return tops[index]! + body.offsetTop + dayY(geometry, minute);
  };

  // Gliding: arrows, Today, and Go to scroll smoothly; the stops and loading wait until the glide arrived.
  let glideTarget: number | null = null;
  let glideTimer = 0;
  const glide = (top: number) => {
    if (!scroller) return;
    const target = Math.round(Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight)));
    glideTarget = target;
    window.clearTimeout(glideTimer);
    glideTimer = window.setTimeout(() => {
      glideTarget = null;
    }, 1600);
    scroller.scrollTo({ top: target, behavior: reducedMotion() ? "instant" : "smooth" });
  };

  /** Puts a day on screen: now in the upper third today, else an hour before its first entry, else its start. */
  const positionAt = (key: string) => {
    if (!scroller) return;
    measure();
    if (key === view.nowKey()) {
      const top = topFor(key, view.nowMinute());
      // Now in the upper third, but never showing the end of the day before above the day's own heading.
      if (top !== null) scroller.scrollTop = Math.max(topFor(key) ?? 0, top - scroller.clientHeight / 3);
      lastScrollTop = scroller.scrollTop;
      return;
    }
    const model = view.dayOf(key);
    const first = Math.min(
      ...model.bands.map((band) => band.start),
      ...model.markers.map((marker) => marker.minute),
      Number.POSITIVE_INFINITY,
    );
    const start = topFor(key);
    if (start === null) return;
    const entry = Number.isFinite(first) && first > 120 ? topFor(key, first - 60) : null;
    scroller.scrollTop = entry === null ? start : Math.max(start, entry - 44);
    lastScrollTop = scroller.scrollTop;
  };

  // Input: the wheel brakes at day starts; a resting scroll glides onto a near one.
  let lastInput: "wheel" | "touch" | "other" = "other";
  let fingers = 0;
  let settling = false;
  let restTimer = 0;
  let frame = 0;
  let ready = false;
  let carry = 0;
  let lastWheel = 0;
  const settle = () => {
    if (!scroller || fingers > 0 || settling || glideTarget !== null || view.dragging()) return;
    const target = settleTarget(tops.slice(1), scroller.scrollTop, lastInput === "touch" ? SETTLE_RADIUS.touch : SETTLE_RADIUS.wheel);
    if (target === undefined) return;
    settling = true;
    scroller.scrollTo({ top: target, behavior: reducedMotion() ? "instant" : "smooth" });
    window.setTimeout(() => {
      settling = false;
    }, 450);
  };
  const onWheel = (event: WheelEvent) => {
    if (!scroller || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || view.dragging()) return;
    const delta = wheelPixels(event.deltaY, event.deltaMode, scroller.clientHeight);
    const top = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    // At the ends the wheel asks for more days instead.
    if ((delta > 0 && top >= max - 1) || (delta < 0 && top <= 1)) {
      loadMore(delta > 0 ? "later" : "earlier");
      return;
    }
    if (event.timeStamp - lastWheel > GESTURE_GAP_MS) carry = 0;
    // A gesture that goes on takes over from a glide onto a day start; the view settles again once it rests.
    settling = false;
    lastWheel = event.timeStamp;
    const next = brakedScroll(tops, top + carry, delta);
    lastInput = "wheel";
    if (next === undefined) {
      carry = 0;
      return;
    }
    event.preventDefault();
    glideTarget = null;
    const bounded = Math.max(0, Math.min(max, next));
    scroller.scrollTop = bounded;
    // Steps too small for a pixel add up instead of vanishing.
    carry = bounded - scroller.scrollTop;
  };

  // Loading: each end asks once per range, and only after the view settled at its first position.
  let askedEarlier = "";
  let askedLater = "";
  const loadMore = (edge: "earlier" | "later") => {
    // Days that come in above move the view, so they wait for a glide to arrive; days below move nothing.
    if (!ready || view.dragging() || (edge === "earlier" && glideTarget !== null)) return;
    const { first, last } = view.range();
    if (edge === "earlier" && props.owner.onLoadEarlier && askedEarlier !== first) {
      askedEarlier = first;
      void props.owner.onLoadEarlier();
    }
    if (edge === "later" && props.owner.onLoadLater && askedLater !== last) {
      askedLater = last;
      void props.owner.onLoadLater();
    }
  };

  let reportTimer = 0;
  const updateChrome = () => {
    if (!scroller) return;
    const top = scroller.scrollTop;
    const index = stopIndexAt(tops, top);
    const key = keysOf(sections[index])[0];
    if (key && key !== untrack(topKey)) {
      setTopKey(key);
      window.clearTimeout(reportTimer);
      reportTimer = window.setTimeout(() => props.owner.onVisibleDateChange?.(view.parseKey(key)), 250);
    }
    for (const [position, section] of sections.entries()) {
      const head = section.firstElementChild as HTMLElement | null;
      if (!head) continue;
      const crossing = position > 0 ? stopCrossing(tops[position]!, top) : 0;
      if (crossing > 0) head.style.setProperty("--k2b-calendar-cross", String(crossing));
      else if (head.style.getPropertyValue("--k2b-calendar-cross")) head.style.removeProperty("--k2b-calendar-cross");
    }
    setTodayPlace(placeOfToday());
    // Only the reader's own scrolling asks for more: days that came in above push the view down, and runs of empty
    // days are short, so asking whenever the view is near an end would load one empty week after the other.
    const direction = Math.sign(top - lastScrollTop);
    lastScrollTop = top;
    if (direction > 0 && top + scroller.clientHeight > scroller.scrollHeight - 2 * scroller.clientHeight) loadMore("later");
    else if (direction < 0 && top < scroller.clientHeight) loadMore("earlier");
    rememberAnchor();
  };
  const onScroll = () => {
    if (!scroller) return;
    if (glideTarget !== null && Math.abs(scroller.scrollTop - glideTarget) < 2) glideTarget = null;
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateChrome();
      });
    window.clearTimeout(restTimer);
    restTimer = window.setTimeout(settle, lastInput === "touch" ? 90 : 160);
  };

  onMount(() => {
    setMounted(true);
    queueMicrotask(() => {
      positionAt(view.anchorKey());
      rememberAnchor();
      ready = true;
      updateChrome();
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            measure();
            restoreAnchor();
          });
    if (track) observer?.observe(track);
    onCleanup(() => {
      observer?.disconnect();
      window.clearTimeout(restTimer);
      window.clearTimeout(reportTimer);
      window.clearTimeout(glideTimer);
      if (frame) cancelAnimationFrame(frame);
    });
  });
  // Before new days or an unfolded run change the page, note where the reader is from the page as it stands: the
  // place remembered in the last frame can be a scroll behind on a busy page. A computation runs before any render
  // effect touches the page.
  createComputed(
    on(
      () => [groupIds(), view.days()] as const,
      () => {
        if (!untrack(mounted)) return;
        measure();
        rememberAnchor();
      },
      { defer: true },
    ),
  );
  // New days above or below, a folded night, or an unfolded run: keep what the reader looks at in place.
  createEffect(
    on(
      () => [groupIds(), view.days()] as const,
      () => {
        if (!untrack(mounted)) return;
        measure();
        restoreAnchor();
        updateChrome();
      },
      { defer: true },
    ),
  );
  // Another date from the host puts that day on screen.
  createEffect(
    on(
      view.anchorKey,
      (key) => {
        if (!untrack(mounted)) return;
        queueMicrotask(() => {
          positionAt(key);
          rememberAnchor();
          updateChrome();
        });
      },
      { defer: true },
    ),
  );

  /** Whether today's day is above, below, or in the view. */
  const placeOfToday = (): "up" | "down" | "" => {
    const key = view.nowKey();
    if (!scroller) return "";
    const section = sectionOf(key);
    if (!section) return key < untrack(topKey) ? "up" : "down";
    const index = sections.indexOf(section);
    const top = scroller.scrollTop;
    if (tops[index]! + section.offsetHeight < top) return "up";
    if (tops[index]! > top + scroller.clientHeight) return "down";
    return "";
  };
  const visibleKeys = () => {
    const first = topKey();
    if (!scroller || sections.length === 0) return { first, last: first };
    const bottom = scroller.scrollTop + scroller.clientHeight;
    const index = stopIndexAt(tops, bottom - 1);
    const keysAtBottom = keysOf(sections[index]);
    return { first, last: keysAtBottom[keysAtBottom.length - 1] ?? first };
  };
  const loaded = (key: string) => key >= view.range().first && key <= view.range().last;
  const goTo = (key: string) => {
    if (!loaded(key) || !scroller) return false;
    measure();
    const top = topFor(key);
    if (top === null) return false;
    glide(top);
    return true;
  };
  const handle: TimeViewHandle = {
    visibleKeys,
    step: (direction) => {
      if (!scroller) return false;
      measure();
      const top = scroller.scrollTop;
      const index = stopIndexAt(tops, top);
      const target = direction > 0 ? tops[index + 1] : top - tops[index]! > 8 ? tops[index] : tops[index - 1];
      if (target === undefined) return false;
      glide(target);
      return true;
    },
    goTo,
    today: () => {
      const key = view.nowKey();
      if (!loaded(key) || !scroller) return false;
      measure();
      const top = topFor(key, view.nowMinute());
      if (top === null) return false;
      glide(Math.max(topFor(key) ?? 0, top - scroller.clientHeight / 3));
      return true;
    },
    todayDirection: () => {
      const key = view.nowKey();
      const { first, last } = view.range();
      if (key < first) return "up";
      if (key > last) return "down";
      return todayPlace();
    },
    controller: {
      quickCreate: (create) => {
        const target = view.createTarget(visibleKeys());
        const body = scroller?.querySelector<HTMLElement>(`[data-calendar-body="${target.key}"]`);
        view.openQuickCreate(
          target.key,
          target.start,
          target.end,
          anchorFor(target.key, target.start, target.end) ?? body ?? scroller!,
          create,
        );
      },
      createTarget: () => {
        const target = view.createTarget(visibleKeys());
        return view.rangeOfSelection(target);
      },
      dragIn: (event, item, onDrop) => view.dragIn(event, item, onDrop, scroller),
    },
  };
  /** The place of a slot on screen for the quick create, when it is in view. */
  const anchorFor = (key: string, start: number, end: number): DOMRect | null => {
    const body = scroller?.querySelector<HTMLElement>(`[data-calendar-body="${key}"]`);
    if (!body || !scroller) return null;
    const rect = body.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    const geometry = readDayGeometry(body, view.wake(), body.dataset.expanded === "true");
    const top = rect.top + dayY(geometry, start);
    const bottom = rect.top + dayY(geometry, end);
    if (bottom < bounds.top + 40 || top > bounds.bottom - 20) return null;
    const left = rect.left + 56;
    const clampedTop = Math.max(bounds.top, top);
    return new DOMRect(left, clampedTop, Math.min(rect.right - left, 320), Math.max(8, Math.min(bottom, bounds.bottom) - clampedTop));
  };
  onMount(() => props.register(handle));
  onCleanup(() => props.register(null));

  /** Tab into the stream lands on the first stop on screen, not on the first loaded day weeks above. */
  let tabbedAt = -1e9;
  onMount(() => {
    const note = (event: KeyboardEvent) => {
      if (event.key === "Tab") tabbedAt = performance.now();
    };
    window.addEventListener("keydown", note, true);
    onCleanup(() => window.removeEventListener("keydown", note, true));
  });
  let restingTop = 0;
  const onFocusIn = (event: FocusEvent) => {
    if (!scroller) return;
    const from = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (performance.now() - tabbedAt > 400 || (from && scroller.contains(from))) {
      restingTop = scroller.scrollTop;
      return;
    }
    if (Math.abs(scroller.scrollTop - restingTop) < 1) return;
    scroller.scrollTop = restingTop;
    const bounds = scroller.getBoundingClientRect();
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.height > 0 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
    };
    const stops = [...scroller.querySelectorAll<HTMLElement>("a[href],button:not([tabindex='-1'])")].filter(visible);
    const back = Boolean(from && scroller.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING);
    (back ? stops[stops.length - 1] : stops[0])?.focus({ preventScroll: true });
  };

  return (
    <div class="k2b-calendar-days" data-view="day" data-dragging={view.dragging() || undefined}>
      <div
        ref={scroller}
        class="k2b-calendar-days__scroll"
        tabIndex={-1}
        aria-describedby={helpId}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchStart={(event) => {
          fingers = event.touches.length;
          lastInput = "touch";
          glideTarget = null;
        }}
        onTouchEnd={(event) => {
          fingers = event.touches.length;
        }}
        onTouchCancel={(event) => {
          fingers = event.touches.length;
        }}
        onFocusIn={onFocusIn}
      >
        <div ref={track} class="k2b-calendar-days__track">
          <For each={groupIds()}>
            {(id) => {
              const group = () => groupsById().get(id);
              return (
                <Show when={group()}>
                  {(current) =>
                    current().kind === "day" ? (
                      <DaySection view={view} dayKey={groupFirst(current())} hover={hover} setHover={setHover} scroller={() => scroller} />
                    ) : (
                      <EmptyRun
                        view={view}
                        keys={(current() as Extract<DayGroup, { kind: "empty" }>).keys}
                        onUnfold={(first) => setUnfolded((value) => new Set([...value, first]))}
                      />
                    )
                  }
                </Show>
              );
            }}
          </For>
          <Show when={props.owner.onLoadLater}>
            <p class="k2b-calendar-days__more">{view.messages().calendarMoreDays}</p>
          </Show>
        </div>
      </div>
      <p class="k2b-calendar-sr" id={helpId}>
        {view.messages().calendarKeyboardHelp}
      </p>
      <TimeQuickCreate view={view} />
    </div>
  );
};

const DaySection = (props: {
  view: TimeView;
  dayKey: string;
  hover: () => { key: string; minute: number } | null;
  setHover: (value: { key: string; minute: number } | null) => void;
  scroller: () => HTMLElement | undefined;
}) => {
  const view = props.view;
  const model = createMemo(() => view.dayOf(props.dayKey));
  const expanded = () => view.nightOpen(props.dayKey, model());
  const headingId = createUniqueId();
  const badge = () => view.props.owner.dayBadges?.[props.dayKey];
  const today = () => props.dayKey === view.calendarToday();
  const selectedDay = () => {
    const current = view.selection();
    return Boolean(current && current.key === props.dayKey && current.start === undefined);
  };
  const soon = () => soonNote(view, props.dayKey);
  const wake = () => view.wake();
  const nowMinute = () => (props.dayKey === view.nowKey() ? view.nowMinute() : null);
  const bands = createMemo(() => dayBands(view, props.dayKey, expanded()));
  const gaps = createMemo(() => dayGaps(view, props.dayKey));
  const markers = () => model().markers.filter((marker) => marker.minute < (expanded() ? DAY_MINUTES : wake()));
  const folded = () => (expanded() ? [] : foldedEntries(view, props.dayKey));
  const nightLabel = () =>
    view.messages().calendarNight({ from: shortDay(view, props.dayKey), to: shortDay(view, addDayKeys(props.dayKey, 1)) });
  const foldLabel = () =>
    view.messages().calendarNightHours({
      from: view.clock(wake()).slice(0, 2),
      to: view.clock(DAY_MINUTES).slice(0, 2),
    });

  // Gaps, bands, and markers in one time order, so Tab runs through the day as it reads.
  const timeline = createMemo(() =>
    [
      ...gaps().map((gap) => ({ at: gap.start, kind: "gap" as const, gap })),
      ...bands().map((band) => ({ at: Math.max(0, band.start), kind: "band" as const, band })),
      ...markers().map((marker) => ({ at: marker.minute, kind: "marker" as const, marker })),
    ].sort((left, right) => left.at - right.at),
  );

  const isEmptyTarget = (target: EventTarget | null) =>
    target instanceof Element &&
    !target.closest("a,button,[data-calendar-event],.k2b-calendar-band,.k2b-calendar-marker,.k2b-calendar-draft,.k2b-calendar-fold");
  const minuteAt = (element: HTMLElement, clientY: number) => {
    const geometry = readDayGeometry(element, wake(), expanded());
    const rect = element.getBoundingClientRect();
    return Math.max(0, Math.min((expanded() ? DAY_MINUTES : wake()) - 15, dayMinuteAt(geometry, clientY - rect.top)));
  };
  let lastPointer = "mouse";

  return (
    <section
      class="k2b-calendar-days__day"
      data-calendar-group=""
      data-calendar-keys={props.dayKey}
      aria-labelledby={headingId}
      data-today={today() ? "true" : undefined}
      data-past={props.dayKey < view.nowKey() ? "true" : undefined}
      data-selected={selectedDay() ? "true" : undefined}
    >
      <header class="k2b-calendar-days__head">
        <h2 class="k2b-calendar-days__title" id={headingId}>
          <button
            type="button"
            class="k2b-calendar-days__title-button"
            aria-pressed={selectedDay() ? "true" : "false"}
            onClick={() => {
              view.setTouchDraft(null);
              view.setSelection(selectedDay() ? null : { key: props.dayKey });
            }}
          >
            <Show when={today()}>
              <span class="k2b-calendar-days__today">{view.props.labels.today}</span>
            </Show>
            <span class="k2b-calendar-days__long">{longDay(view, props.dayKey)}</span>
            <span class="k2b-calendar-days__short">{shortDay(view, props.dayKey, true)}</span>
          </button>
        </h2>
        <span class="k2b-calendar-days__note">
          <Show when={soon()}>
            <i class="ti ti-clock" aria-hidden="true" />
            <span>{soon()}</span>
          </Show>
        </span>
        <Show when={badge()}>
          {(current) => (
            <span class="k2b-calendar-days__badge">
              <Show when={current().icon}>{(icon) => <i class={`ti ti-${icon()}`} aria-hidden="true" />}</Show>
              {current().label}
            </span>
          )}
        </Show>
        <span class="k2b-calendar-days__summary">{daySummary(view, props.dayKey)}</span>
      </header>
      <Show when={model().spans.length > 0}>
        <div class="k2b-calendar-days__all-day" role="group" aria-label={view.messages().calendarAllDayAndDue}>
          <AllDayChips view={view} dayKey={props.dayKey} spans={model().spans} />
        </div>
      </Show>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: free time is reached through its gap buttons; the pointer adds drawing and slots. */}
      <div
        ref={(element) => view.registerBody(props.dayKey, element, expanded)}
        class="k2b-calendar-days__body"
        data-calendar-body={props.dayKey}
        data-expanded={expanded() ? "true" : "false"}
        style={{ height: termsCss(dayHeightTerms(wake(), expanded())) }}
        onPointerDown={(event) => {
          lastPointer = event.pointerType;
          if (event.button !== 0 || !isEmptyTarget(event.target)) return;
          view.startDraw(event, props.dayKey, props.scroller());
        }}
        // Some engines send a tap as touch events only; a tap is a tap either way.
        onTouchStart={() => {
          lastPointer = "touch";
        }}
        // Listening on the timeline itself, not through delegation, makes it a tap target on iOS.
        on:click={(event) => {
          if (!isEmptyTarget(event.target) || !view.canCreate()) return;
          const minute = Math.floor(minuteAt(event.currentTarget, event.clientY) / 30) * 30;
          const end = Math.min(minute + 60, expanded() ? DAY_MINUTES : wake());
          if (lastPointer === "mouse") {
            view.setTouchDraft(null);
            view.setSelection({ key: props.dayKey, start: minute, end });
            return;
          }
          view.setTouchDraft({ key: props.dayKey, start: minute, end });
          view.setSelection({ key: props.dayKey, start: minute, end });
        }}
        onDblClick={(event) => {
          if (!isEmptyTarget(event.target) || lastPointer !== "mouse") return;
          const minute = Math.floor(minuteAt(event.currentTarget, event.clientY) / 30) * 30;
          view.openQuickCreate(props.dayKey, minute, Math.min(minute + 60, expanded() ? DAY_MINUTES : wake()), event.currentTarget);
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== "mouse" || view.dragging() || !isEmptyTarget(event.target)) {
            if (props.hover()?.key === props.dayKey) props.setHover(null);
            return;
          }
          const minute = Math.floor(minuteAt(event.currentTarget, event.clientY) / 15) * 15;
          props.setHover({ key: props.dayKey, minute });
        }}
        onPointerLeave={() => {
          if (props.hover()?.key === props.dayKey) props.setHover(null);
        }}
      >
        <For each={Array.from({ length: wake() / 60 + 1 }, (_, index) => index * 60)}>
          {(minute) => (
            <>
              <span class="k2b-calendar-days__line" style={{ top: termsCss(dayYTerms(wake(), expanded(), minute)) }} aria-hidden="true" />
              <span
                class="k2b-calendar-days__hour"
                data-near-now={isNearNow(view, props.dayKey, minute) ? "true" : undefined}
                style={{ top: termsCss(dayYTerms(wake(), expanded(), minute)) }}
                aria-hidden="true"
              >
                {view.clock(minute)}
              </span>
            </>
          )}
        </For>
        <Show
          when={expanded()}
          fallback={
            <div class="k2b-calendar-fold" style={{ top: `calc(${termsCss(dayYTerms(wake(), false, wake()))} + 3px)` }}>
              <button
                type="button"
                class="k2b-calendar-fold__toggle"
                aria-expanded="false"
                aria-label={view.messages().calendarOpenNight}
                onClick={() => view.setNight(props.dayKey, true)}
              >
                <i class="ti ti-moon" aria-hidden="true" />
                <span>{foldLabel()}</span>
                <i class="ti ti-chevron-down" aria-hidden="true" />
              </button>
              <Show when={folded().length > 0}>
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
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          }
        >
          <span
            class="k2b-calendar-night"
            style={{ top: termsCss(dayYTerms(wake(), true, wake())), height: termsCss(dayHeightTermsNight(wake())) }}
            aria-hidden="true"
          />
          <button
            type="button"
            class="k2b-calendar-night__bar"
            aria-expanded="true"
            style={{ top: termsCss(dayYTerms(wake(), true, wake())) }}
            onClick={() => view.setNight(props.dayKey, false)}
          >
            <i class="ti ti-moon" aria-hidden="true" />
            <span>{nightLabel()}</span>
            <span class="k2b-calendar-night__action">
              {view.messages().calendarFoldNight}
              <i class="ti ti-chevron-up" aria-hidden="true" />
            </span>
          </button>
          <For each={nightHours(wake())}>
            {(minute) => (
              <>
                <span
                  class="k2b-calendar-days__line"
                  data-midnight={view.clock(minute) === "00:00" ? "true" : undefined}
                  style={{ top: termsCss(dayYTerms(wake(), true, minute)) }}
                  aria-hidden="true"
                />
                <span
                  class="k2b-calendar-days__hour"
                  data-night="true"
                  style={{ top: termsCss(dayYTerms(wake(), true, minute)) }}
                  aria-hidden="true"
                >
                  {view.clock(minute)}
                </span>
                <Show when={view.clock(minute) === "00:00"}>
                  <span class="k2b-calendar-days__midnight" style={{ top: termsCss(dayYTerms(wake(), true, minute)) }} aria-hidden="true">
                    {shortDay(view, addDayKeys(props.dayKey, 1), true)}
                  </span>
                </Show>
              </>
            )}
          </For>
        </Show>
        <For each={timeline()}>
          {(entry) =>
            entry.kind === "gap" ? (
              <TimeGap view={view} gap={entry.gap} dayKey={props.dayKey} expanded={expanded()} aside={gapAside(model(), entry.gap)} />
            ) : entry.kind === "band" ? (
              <TimeBand
                view={view}
                band={entry.band}
                dayKey={props.dayKey}
                expanded={expanded()}
                showLocation
                hourPx={56}
                scroller={props.scroller}
              />
            ) : (
              <TimeMarker
                view={view}
                event={entry.marker.item}
                minute={entry.marker.minute}
                dayKey={props.dayKey}
                expanded={expanded()}
                above={markerAbove(model(), entry.marker.minute)}
                showTime
                scroller={props.scroller}
              />
            )
          }
        </For>
        <TimeOverlays view={view} dayKey={props.dayKey} expanded={expanded()} />
        <Show when={props.hover()?.key === props.dayKey && props.hover()}>
          {(current) => (
            <span class="k2b-calendar-hover" style={{ top: termsCss(dayYTerms(wake(), expanded(), current().minute)) }} aria-hidden="true">
              {view.clock(current().minute)}
            </span>
          )}
        </Show>
        <Show when={nowMinute() !== null && nowMinute()! >= 0 && nowMinute()! < (expanded() ? DAY_MINUTES : wake())}>
          <div class="k2b-calendar-now" style={{ top: termsCss(dayYTerms(wake(), expanded(), nowMinute()!)) }} aria-hidden="true">
            <span class="k2b-calendar-now__time">{view.clock(nowMinute()!)}</span>
          </div>
        </Show>
      </div>
    </section>
  );
};

const dayHeightTermsNight = (wake: number) => {
  const total = dayHeightTerms(wake, true);
  return [0, total[1], total[2], 0] as const;
};

const EmptyRun = (props: { view: TimeView; keys: string[]; onUnfold: (first: string) => void }) => {
  const view = props.view;
  const headingId = createUniqueId();
  const first = () => props.keys[0]!;
  const last = () => props.keys[props.keys.length - 1]!;
  const title = () => (props.keys.length === 1 ? longDay(view, first()) : `${shortDay(view, first())} – ${shortDay(view, last(), true)}`);
  return (
    <section
      class="k2b-calendar-days__day"
      data-calendar-group=""
      data-calendar-keys={props.keys.join(",")}
      data-empty="true"
      data-past={last() < view.nowKey() ? "true" : undefined}
      aria-labelledby={headingId}
    >
      <header class="k2b-calendar-days__head">
        <h2 class="k2b-calendar-days__title" id={headingId}>
          <span class="k2b-calendar-days__run">{title()}</span>
        </h2>
        <span class="k2b-calendar-days__note" />
        <For each={props.keys.filter((key) => view.props.owner.dayBadges?.[key])}>
          {(key) => {
            const badge = view.props.owner.dayBadges![key]!;
            return (
              <span class="k2b-calendar-days__badge" data-run="true">
                <Show when={props.keys.length > 1}>
                  <span class="k2b-calendar-days__badge-day">{shortDay(view, key).split(/[\s,.]/)[0]}</span>
                </Show>
                <Show when={badge.icon}>{(icon) => <i class={`ti ti-${icon()}`} aria-hidden="true" />}</Show>
                {badge.label}
              </span>
            );
          }}
        </For>
        <span class="k2b-calendar-days__summary">
          {props.keys.length > 1 ? view.messages().calendarDayCount({ count: props.keys.length }) : ""}
        </span>
      </header>
      <button type="button" class="k2b-calendar-days__empty" data-calendar-unfold="" onClick={() => props.onUnfold(first())}>
        <span>{view.messages().calendarNothingPlannedShort}</span>
        <span class="k2b-calendar-days__empty-action">
          <i class="ti ti-arrows-vertical" aria-hidden="true" />
          {view.messages().calendarUnfoldDays({ count: props.keys.length })}
        </span>
      </button>
    </section>
  );
};
