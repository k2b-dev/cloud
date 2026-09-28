import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts";
import type { VenueDashboard } from "../../../contracts";
import type { VenueDashboardSource } from "../../dashboard-query";
import type { VenueCalendarView } from "../../schedule-url";

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
  initialCalendarView: VenueCalendarView;
  /** Where the view came from; only a first visit (`default`) may switch a phone to its month view. */
  initialCalendarViewSource?: "url" | "cookie" | "default";
  initialCalendarDate: string;
  /** `?gaps=1`: the calendar shows only shifts that still miss people. */
  initialGapsOnly?: boolean;
  /** `?shift=`: the slot (`<templateId>:<date>`) or sign-up (`a:<assignmentId>`) whose detail is open. */
  initialShiftId?: string | null;
  initialFeedbackDays: FeedbackRange;
  initialFeedbackSearch: string;
  initialFeedbackComments?: boolean;
};
