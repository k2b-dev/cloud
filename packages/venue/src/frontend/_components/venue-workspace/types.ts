import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts";
import type { CalendarView } from "@k2b/ui";
import type { VenueDashboard } from "../../../contracts";
import type { VenueDashboardSource } from "../../dashboard-query";

export type VenueView = "shifts" | "my-shifts" | "feedback";
export type FeedbackRange = 7 | 14 | 30;

export type VenueWorkspaceProps = {
  dashboard: VenueDashboard;
  dashboardSource: VenueDashboardSource;
  userId: string;
  /** The viewer's personal iCal subscription URL; renewing it replaces the token. */
  calendarUrl: string;
  accessEntries: AccessEntry[];
  apiKeys: ResourceApiKey[];
  initialView: VenueView;
  initialSectionId?: string | null;
  initialCalendarView: CalendarView;
  initialCalendarDate: string;
  initialFeedbackDays: FeedbackRange;
  initialFeedbackSearch: string;
  initialFeedbackComments?: boolean;
};
