import type { DateContext } from "@k2b/stdlib";
import { dates } from "@k2b/stdlib";
import { Timeline, type TimelineColor, type TimelineController, type TimelineItem, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { CalendarItem } from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import { confirmCompletion, setItemCompleted } from "../shared/completion";
import { invalidateSpacesData, requestSpacesRouteNavigation } from "../workspace/workspace-events";
import type { TimelineRange } from "./timeline";

/** The calendar's color for an event without a tag. */
const EVENT_COLOR = "#0ea5e9";

const isHexColor = (value: string | undefined): value is `#${string}` => value?.startsWith("#") ?? false;

/**
 * One calendar item on the timeline. Events are bands over their time. A task's deadline always carries a time, so it
 * is a marker at that time; only a task whose due day was set as a whole day sits in the all-day row.
 */
export const toTimelineItem = (
  item: CalendarItem,
  options: { href: string; checked?: boolean; dateConfig?: DateContext },
): TimelineItem | null => {
  const base = { id: item.id, label: item.title, href: options.href };
  if (item.startsAt && item.endsAt) {
    const tagColor = item.tags?.[0]?.color;
    return {
      ...base,
      start: item.startsAt,
      end: item.endsAt,
      allDay: item.allDay,
      color: isHexColor(tagColor) ? tagColor : EVENT_COLOR,
      detail: item.location ?? undefined,
    };
  }
  const deadline = item.deadline;
  if (!deadline) return null;
  return {
    ...base,
    kind: "marker",
    start: item.allDay ? dates.formatDateKey(deadline, options.dateConfig) : deadline,
    allDay: item.allDay || undefined,
    color: (item.priority === "urgent" || item.priority === "high" ? "red" : "amber") satisfies TimelineColor,
    checked: options.checked,
  };
};

const isTask = (item: CalendarItem) => !(item.startsAt && item.endsAt);

type Props = {
  spaceId: string;
  range: TimelineRange;
  items: CalendarItem[];
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
      const entry = toTimelineItem(item, {
        href: props.hrefFor(item),
        checked: props.canWrite && isTask(item) ? (checking()[item.id] ?? false) : undefined,
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
