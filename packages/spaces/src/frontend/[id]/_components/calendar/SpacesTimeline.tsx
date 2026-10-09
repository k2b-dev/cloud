import type { DateContext } from "@k2b/stdlib";
import { dates } from "@k2b/stdlib";
import { Timeline, type TimelineController, type TimelineItem, toast } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { CalendarItem, SpaceColumn, SpaceItem } from "@/contracts";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import { ownClaimId } from "../shared/claim/claim";
import { confirmCompletion, setItemCompleted } from "../shared/completion";
import { invalidateSpacesData, requestSpacesRouteNavigation } from "../workspace/workspace-events";
import type { TimelineTray as Tray } from "../workspace/workspace-types";
import { calendarItemColors, isCalendarFlagged, isCalendarTask } from "./colors";
import type { CalendarColorBy } from "./filter";
import TimelineTray from "./TimelineTray";
import type { TimelineRange, TimelineTraySection } from "./timeline";

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
  /** The reader, whose own claim on a task in the tray goes with checking it off. */
  currentUserId?: string;
  dateConfig?: DateContext;
  /** The detail link of an item, kept in the timeline's URL. */
  hrefFor: (item: CalendarItem) => string;
  /** Overdue and undated tasks, shown in a fixed row below the strip. */
  tray: Tray | null;
  /** Whether the calendar's filter narrows the tray. */
  trayFiltered: boolean;
  trayItemHref: (item: SpaceItem) => string;
  trayListHref: (section: TimelineTraySection) => string | undefined;
  onLoadEarlier: () => Promise<void>;
  onLoadLater: () => Promise<void>;
  controller?: (controller: TimelineController) => void;
};

/** The Spaces calendar as one continuous strip of time, with the tasks it has no place for in a row below. */
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
  /** A task the reader claimed completes with that claim; one claimed by someone else is refused with the reason. */
  const toggle = async (itemId: string, completed: boolean, claimId?: string) => {
    if (itemId in checking()) return;
    setChecking((current) => ({ ...current, [itemId]: completed }));
    try {
      await setItemCompleted({ spaceId: props.spaceId, itemId, completed, claimId }, t.updateFailed);
    } catch (error) {
      settle(itemId);
      toast.error(error instanceof Error ? error.message : t.updateFailed);
      return;
    }
    // A completed task leaves the timeline and the tray with the refresh, so the toast confirms it and offers Undo.
    confirmCompletion({ spaceId: props.spaceId, itemId, completed }, t);
    await refresh();
    settle(itemId);
  };

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="min-h-0 flex-1">
        <Timeline
          items={items()}
          from={props.range.from}
          to={props.range.to}
          dateConfig={props.dateConfig}
          label={t.timeline}
          busy={props.busy}
          onActivate={(item) => item.href && requestSpacesRouteNavigation(item.href, { scroll: "preserve" })}
          onToggle={props.canWrite ? (item, checked) => void toggle(item.id, checked) : undefined}
          onLoadEarlier={props.onLoadEarlier}
          onLoadLater={props.onLoadLater}
          controller={props.controller}
        />
      </div>
      <Show when={props.tray}>
        {(tray) => (
          <TimelineTray
            tray={tray()}
            filtered={props.trayFiltered}
            canCheck={props.canWrite}
            checking={checking()}
            onToggle={(item, completed) =>
              void toggle(item.id, completed, props.currentUserId ? ownClaimId(item.claim, props.currentUserId) : undefined)
            }
            itemHref={props.trayItemHref}
            listHref={props.trayListHref}
            dateConfig={props.dateConfig}
          />
        )}
      </Show>
    </div>
  );
}
