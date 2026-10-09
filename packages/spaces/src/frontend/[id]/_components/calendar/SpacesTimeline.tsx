import type { DateContext } from "@k2b/stdlib";
import { dates } from "@k2b/stdlib";
import { Timeline, type TimelineController, type TimelineItem, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { CalendarItem, SpaceColumn } from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import { confirmCompletion, setItemCompleted } from "../shared/completion";
import { invalidateSpacesData, requestSpacesRouteNavigation } from "../workspace/workspace-events";
import { calendarItemColors, isCalendarFlagged, isCalendarTask } from "./colors";
import type { CalendarColorBy } from "./filter";
import type { TimelineRange } from "./timeline";

const isHexColor = (value: string): value is `#${string}` => value.startsWith("#");

/**
 * One calendar item on the timeline, colored by the rule of every calendar view. Events are bands over their time. A
 * task's deadline always carries a time, so it is a marker at that time; only a task whose due day was set as a whole
 * day sits in the all-day row. `detail` says what the other views show as a flag, and why a task has no checkbox.
 */
const toTimelineItem = (
  item: CalendarItem,
  options: { href: string; color: string; detail?: string; checked?: boolean; dateConfig?: DateContext },
): TimelineItem | null => {
  const base = { id: item.id, label: item.title, href: options.href, color: isHexColor(options.color) ? options.color : undefined };
  if (item.startsAt && item.endsAt) {
    return { ...base, start: item.startsAt, end: item.endsAt, allDay: item.allDay, detail: item.location ?? undefined };
  }
  const deadline = item.deadline;
  if (!deadline) return null;
  return {
    ...base,
    kind: "marker",
    start: item.allDay ? dates.formatDateKey(deadline, options.dateConfig) : deadline,
    allDay: item.allDay || undefined,
    detail: options.detail,
    checked: options.checked,
  };
};

type Props = {
  spaceId: string;
  range: TimelineRange;
  items: CalendarItem[];
  columns: SpaceColumn[];
  colorBy: CalendarColorBy;
  busy: boolean;
  canWrite: boolean;
  dateConfig?: DateContext;
  /** The detail link of an item, kept in the timeline's URL. */
  hrefFor: (item: CalendarItem) => string;
  onLoadEarlier: () => Promise<void>;
  onLoadLater: () => Promise<void>;
  controller?: (controller: TimelineController) => void;
};

/** The Spaces calendar as one continuous strip of time. */
export default function SpacesTimeline(props: Props) {
  const t = useSpaceMessages();
  const retryToast = createRetryToasts();
  /** Checkbox states the reader just set, shown until the refresh after the change is in. */
  const [checking, setChecking] = createSignal<Record<string, boolean>>({});
  const settle = (id: string) =>
    setChecking((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  const items = () =>
    props.items.flatMap((item) => {
      const task = isCalendarTask(item);
      // A blocked task cannot be completed, so it gets no checkbox, as in the list.
      const blocked = task && item.activeBlockerCount > 0;
      const detail = [
        task && isCalendarFlagged(item) ? `${t.priority}: ${item.priority === "urgent" ? t.urgent : t.high}` : null,
        blocked ? t.blockedByCount({ count: item.activeBlockerCount }) : null,
      ]
        .filter(Boolean)
        .join(", ");
      const entry = toTimelineItem(item, {
        href: props.hrefFor(item),
        color: calendarItemColors(item, props.colorBy, props.columns).color,
        detail: detail || undefined,
        checked: props.canWrite && task && !blocked ? (checking()[item.id] ?? false) : undefined,
        dateConfig: props.dateConfig,
      });
      return entry ? [entry] : [];
    });
  const refresh = (): Promise<void> => invalidateSpacesData().catch(() => retryToast(t.calendarRefreshFailed, t.retry, () => refresh()));
  const toggle = async (entry: TimelineItem, completed: boolean) => {
    if (entry.id in checking()) return;
    setChecking((current) => ({ ...current, [entry.id]: completed }));
    try {
      await setItemCompleted({ spaceId: props.spaceId, itemId: entry.id, completed }, t.updateFailed);
    } catch (error) {
      settle(entry.id);
      toast.error(error instanceof Error ? error.message : t.updateFailed);
      return;
    }
    // A completed task leaves the timeline with the refresh, so the toast confirms it and offers Undo.
    confirmCompletion({ spaceId: props.spaceId, itemId: entry.id, completed }, t);
    await refresh();
    settle(entry.id);
  };

  return (
    <Timeline
      items={items()}
      from={props.range.from}
      to={props.range.to}
      dateConfig={props.dateConfig}
      label={t.timeline}
      busy={props.busy}
      onActivate={(item) => item.href && requestSpacesRouteNavigation(item.href, { scroll: "preserve" })}
      onToggle={props.canWrite ? (item, checked) => void toggle(item, checked) : undefined}
      onLoadEarlier={props.onLoadEarlier}
      onLoadLater={props.onLoadLater}
      controller={props.controller}
    />
  );
}
