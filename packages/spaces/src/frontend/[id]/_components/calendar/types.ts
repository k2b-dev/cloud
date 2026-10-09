import type { DateContext } from "@k2b/stdlib";
import type { CalendarItem, SpaceColumn, SpaceItemTemplate, SpaceTag } from "@/contracts";
import type { TimelineTray } from "../workspace/workspace-types";
import type { CalendarFilter } from "./filter";
import type { TimelineRange } from "./timeline";

export type CalendarView = "day" | "week" | "month" | "year" | "timeline";

/** Weather data for a specific date */
export type DayWeather = {
  tempMin: number;
  tempMax: number;
  icon: string; // Tabler icon name
};

export type CalendarProps = {
  spaceId: string;
  items: CalendarItem[];
  columns: SpaceColumn[];
  tags: SpaceTag[];
  /** Event templates offered when a slot creates an event. */
  templates?: SpaceItemTemplate[];
  filter: CalendarFilter;
  selectedItemId?: string;
  view: CalendarView;
  date: Date;
  baseUrl: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  /** The reader, whose own claim on a task goes with checking it off in the timeline's tray. */
  currentUserId?: string;
  onNavigateHref?: (href: string) => void;
  onRouteChange?: (href: string, options?: { replace?: boolean }) => void | Promise<void>;
  onPrefetch?: (href: string) => void;
  navigationPending?: boolean;
  /** Weather forecasts indexed by date string (YYYY-MM-DD) */
  weather?: Record<string, DayWeather>;
  /** The loaded days of the timeline view, once they are in. */
  timeline?: CalendarTimeline;
};

export type CalendarTimeline = TimelineRange & {
  /** The day the timeline opened on; another anchor opens a new strip. */
  anchor: string;
  /** The filter the strip's items were loaded with, which a pending filter change has not replaced yet. */
  filter: CalendarFilter;
  items: CalendarItem[];
  /** Overdue and undated tasks below the strip, from the snapshot the strip loaded with. */
  tray: TimelineTray | null;
  busy: boolean;
  onLoadEarlier: () => Promise<void>;
  onLoadLater: () => Promise<void>;
};
