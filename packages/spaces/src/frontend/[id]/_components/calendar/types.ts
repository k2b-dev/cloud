import type { DateContext } from "@k2b/stdlib";
import type { CalendarItem, SpaceColumn, SpaceItemTemplate, SpaceTag } from "@/contracts";
import type { CalendarFilter } from "./filter";

export type CalendarView = "day" | "week" | "month" | "year";

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
  onNavigateHref?: (href: string) => void;
  onRouteChange?: (href: string, options?: { replace?: boolean }) => void | Promise<void>;
  onPrefetch?: (href: string) => void;
  navigationPending?: boolean;
  /** Weather forecasts indexed by date string (YYYY-MM-DD) */
  weather?: Record<string, DayWeather>;
};
