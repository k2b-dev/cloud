import type { NavGroup, NavItem } from "@k2b/ui/v2";
import type { Venue, VenueDashboard } from "../../contracts";

import type { VenueView } from "../_components/venue-workspace/types";
import { canAdmin, canWrite } from "../_components/venue-workspace/utils";
import type { useVenueWords } from "./messages";

type Words = ReturnType<typeof useVenueWords>;

/** The areas of a venue's settings page, each a tab in the address. */
export type VenueSettingsTab = "general" | "access" | "schedule" | "danger";

export const venueViewHref = (venueId: string, view: VenueView) => `/app/venue/${encodeURIComponent(venueId)}/${view}`;
export const venueSettingsHref = (venueId: string, tab: VenueSettingsTab = "general") =>
  `/app/venue/${encodeURIComponent(venueId)}/settings${tab === "general" ? "" : `/${tab}`}`;

/**
 * The sidebar of one venue: the way to all venues, the venue's areas (schedule, my shifts, feedback for staff, the
 * public page for admins; everyone else gets its links from a dialog), and the settings at the foot for admins.
 */
export const venueNav = (
  words: Words,
  dashboard: Pick<VenueDashboard, "venue" | "myShiftCount" | "feedback">,
  current: VenueView | "settings",
  openPublicLink: () => void,
): { groups: NavGroup[]; foot: NavItem[] } => {
  const { t } = words;
  const venue: Venue = dashboard.venue;
  const areas: NavItem[] = [
    { label: t().schedule, icon: "calendar-event", href: venueViewHref(venue.id, "shifts"), current: current === "shifts" },
    {
      label: t().myShifts,
      icon: "user-check",
      href: venueViewHref(venue.id, "my-shifts"),
      current: current === "my-shifts",
      count: dashboard.myShiftCount || undefined,
    },
    ...(canWrite(venue)
      ? [
          {
            label: t().feedback,
            icon: "message-star",
            href: venueViewHref(venue.id, "feedback"),
            current: current === "feedback",
            count: dashboard.feedback?.count || undefined,
          },
        ]
      : []),
    canAdmin(venue)
      ? { label: t().publicPage, icon: "world", href: venueViewHref(venue.id, "public"), current: current === "public" }
      : { label: t().publicPage, icon: "world", onClick: openPublicLink },
  ];
  return {
    groups: [{ items: [{ label: words.words().allVenues, icon: "layout-grid", href: "/app/venue" }] }, { label: venue.name, items: areas }],
    foot: canAdmin(venue)
      ? [{ label: t().venueSettings, icon: "settings", href: venueSettingsHref(venue.id), current: current === "settings" }]
      : [],
  };
};
