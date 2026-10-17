import { dates } from "@k2b/stdlib";
import { Format, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import type { GraphDisplayProps } from "./GraphCanvas";
import { type GraphNote, matchesQuery } from "./model";
import { timelineArc, timelineGroupLabel, timelineGroups } from "./timeline";

type Props = Omit<GraphDisplayProps, "displayName" | "filterKey"> & {
  timeZone: string;
  noteHref: (id: string) => string;
};
type Geometry = { dotX: number; height: number; centres: ReadonlyMap<string, number> };

/** Rows own their geometry in CSS; only the decorative links need browser measurements. */
export default function TimelineDisplay(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  let scroller!: HTMLDivElement;
  let wrap!: HTMLDivElement;
  const groups = createMemo(() => timelineGroups(props.notes, { now: props.now, timeZone: props.timeZone }));
  const ordered = createMemo(() => groups().flatMap((group) => group.notes));
  const visible = createMemo(() => new Set(props.notes.map((note) => note.id)));
  const [tabStop, setTabStop] = createSignal<string | null>(null);
  const tabTarget = () => {
    const id = tabStop();
    return id && visible().has(id) ? id : props.currentId && visible().has(props.currentId) ? props.currentId : ordered()[0]?.id;
  };
  const [focused, setFocused] = createSignal<string | null>(null);
  const [hovered, setHovered] = createSignal<string | null>(null);
  const highlight = () => focused() ?? hovered();
  const near = createMemo(() => {
    const id = highlight();
    const note = id ? props.model.byId.get(id) : undefined;
    return new Set(note ? [note.id, ...note.neighbours].filter((key) => visible().has(key)) : []);
  });
  const [geometry, setGeometry] = createSignal<Geometry>({ dotX: 0, height: 0, centres: new Map() });
  const drawnEdges = createMemo(() => {
    const centres = geometry().centres;
    return props.edges.filter((edge) => centres.has(edge.source) && centres.has(edge.target));
  });
  const row = (id: string) => wrap.querySelector<HTMLAnchorElement>(`[data-row="${id}"]`);
  const focusRow = (id: string) => {
    const target = row(id);
    if (!target) return;
    setTabStop(id);
    setFocused(id);
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest" });
  };
  const measure = () => {
    const rows = [...wrap.querySelectorAll<HTMLAnchorElement>("[data-row]")];
    const dot = rows[0]?.querySelector<HTMLElement>(".notebook-graph__row-dot")?.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    setGeometry({
      dotX: dot ? dot.left + dot.width / 2 - box.left : 0,
      height: wrap.scrollHeight,
      centres: new Map(rows.map((element) => [element.dataset.row!, element.offsetTop + element.offsetHeight / 2])),
    });
  };
  let mounted = false;
  onMount(() => {
    mounted = true;
    props.controls(null);
    measure();
    if (props.claimFocus() && tabTarget()) focusRow(tabTarget()!);
    const current = props.currentId ? row(props.currentId) : null;
    if (current) scroller.scrollTop = Math.max(0, current.offsetTop + current.offsetHeight / 2 - scroller.clientHeight / 3);
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    props.focusRequest((id) => {
      const firstMatch = props.query.trim() ? ordered().find((note) => matchesQuery(note, props.query)) : undefined;
      const target = firstMatch?.id ?? id;
      if (target) focusRow(target);
    });
    onCleanup(() => {
      mounted = false;
      observer.disconnect();
    });
  });
  createEffect(() => {
    ordered();
    // Wait until Solid has updated the keyed rows before reading their layout.
    queueMicrotask(() => {
      if (mounted) measure();
    });
  });
  createEffect(() => {
    if (focused() && !visible().has(focused()!)) setFocused(null);
    if (hovered() && !visible().has(hovered()!)) setHovered(null);
    if (tabStop() && !visible().has(tabStop()!)) setTabStop(ordered()[0]?.id ?? null);
  });
  const label = (note: GraphNote) =>
    `${t().graphNodeLabel({
      title: note.title || t().untitled,
      area: note.area.index === 0 ? null : note.area.title || t().untitled,
      out: note.out.size,
      incoming: note.in.size,
      current: note.id === props.currentId,
    })}, ${t().graphChanged} ${dates.formatTimeSpan(note.updatedAt, { locale: locale(), base: props.now })}`;
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("[data-row]") : null;
    if (!target) return;
    const id = target.dataset.row;
    if (event.key === "Escape") {
      event.preventDefault();
      if (props.query.trim()) props.onClearQuery();
      else target.blur();
    } else if (event.key === "Home") {
      event.preventDefault();
      if (props.currentId) focusRow(props.currentId);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = ordered().findIndex((note) => note.id === id);
      const next = ordered()[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) focusRow(next.id);
    }
  };
  return (
    <div
      ref={scroller}
      class="notebook-graph__timeline"
      data-display="timeline"
      data-highlight={highlight() ? "" : undefined}
      data-query={props.query.trim() ? "" : undefined}
      onPointerOver={(event) => {
        if (event.pointerType !== "mouse") return;
        const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("[data-row]") : null;
        setHovered(target?.dataset.row ?? null);
      }}
      onPointerLeave={() => setHovered(null)}
      onFocusIn={(event) => {
        const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("[data-row]") : null;
        if (!target?.dataset.row) return;
        setTabStop(target.dataset.row);
        setFocused(target.matches(":focus-visible") ? target.dataset.row : null);
      }}
      onFocusOut={() => setFocused(null)}
    >
      <div
        ref={wrap}
        class="notebook-graph__timeline-wrap"
        role="group"
        aria-label={t().graphTimelineLabel({ notebook: props.notebookName, count: props.notes.length })}
      >
        <svg class="notebook-graph__arcs" aria-hidden="true" width={geometry().dotX + 2} height={geometry().height}>
          <For each={drawnEdges()}>
            {(edge) => (
              <path
                class="notebook-graph__arc"
                data-slot={props.model.byId.get(edge.source)?.area.slot}
                data-source={edge.source}
                data-target={edge.target}
                data-near={edge.source === highlight() ? "out" : edge.target === highlight() ? "in" : undefined}
                d={timelineArc(
                  geometry().dotX,
                  geometry().centres.get(edge.source)!,
                  geometry().centres.get(edge.target)!,
                  geometry().dotX,
                )}
              />
            )}
          </For>
        </svg>
        <For each={groups()}>
          {(group) => (
            <>
              <div class="notebook-graph__timeline-group">
                {timelineGroupLabel(group, {
                  locale: locale(),
                  timeZone: props.timeZone,
                  labels: {
                    today: t().graphTimelineToday,
                    yesterday: t().graphTimelineYesterday,
                    thisWeek: t().graphTimelineThisWeek,
                    lastWeek: t().graphTimelineLastWeek,
                  },
                })}
              </div>
              <For each={group.notes}>
                {(note) => (
                  <a
                    class="notebook-graph__row"
                    href={props.noteHref(note.id)}
                    data-row={note.id}
                    data-slot={note.area.slot}
                    data-orphan={note.orphan ? "" : undefined}
                    data-current={note.id === props.currentId ? "" : undefined}
                    data-near={near().has(note.id) ? "" : undefined}
                    data-match={matchesQuery(note, props.query) ? "" : undefined}
                    tabindex={tabTarget() === note.id ? 0 : -1}
                    aria-label={label(note)}
                    aria-current={note.id === props.currentId ? "page" : undefined}
                    onKeyDown={onKeyDown}
                    onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      props.onOpen(note.id);
                    }}
                  >
                    <span class="notebook-graph__row-dot" aria-hidden="true" />
                    <span class="notebook-graph__row-title">{note.title || t().untitled}</span>
                    <span class="notebook-graph__row-area">
                      {note.area.index === 0 ? t().graphTopLevel : note.area.title || t().untitled}
                    </span>
                    <span class="notebook-graph__row-meta" aria-hidden="true">
                      <span>
                        <i class="ti ti-arrow-up-right" aria-hidden="true" />
                        {note.out.size}
                      </span>
                      <span>
                        <i class="ti ti-arrow-down-left" aria-hidden="true" />
                        {note.in.size}
                      </span>
                      <span class="notebook-graph__row-time">
                        <Format.RelativeTime value={note.updatedAt} base={props.now} />
                      </span>
                    </span>
                  </a>
                )}
              </For>
            </>
          )}
        </For>
      </div>
    </div>
  );
}
