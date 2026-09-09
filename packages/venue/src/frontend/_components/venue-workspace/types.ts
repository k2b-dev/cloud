import type { CalendarView } from "@k2b/ui";
import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts";
import type { VenueDashboard } from "../../../contracts";
import type { VenueDashboardSource } from "../../dashboard-query";

export type VenueView = "shifts" | "my-shifts" | "feedback";
export type FeedbackRange = 7 | 14 | 30;
export type FeedbackBucket = VenueDashboard["feedback"]["buckets"][number];

export type VenueWorkspaceProps = {
  dashboard: VenueDashboard;
  dashboardSource: VenueDashboardSource;
  userId: string;
  icalToken: string;
  accessEntries: AccessEntry[];
  apiKeys: ResourceApiKey[];
  initialView: VenueView;
  initialSectionId?: string | null;
  initialCalendarView: CalendarView;
  initialCalendarDate: string;
  initialFeedbackDays: FeedbackRange;
  initialFeedbackSearch: string;
};
