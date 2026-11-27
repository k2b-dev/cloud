import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import type { ServiceError } from "@k2b/stdlib";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { PublicStatus } from "../contracts";
import { SHORT_ID_REGEX } from "../lib/short-id";
import { venueService } from "../service";
import { loadVenueSettingsContext } from "../service/settings-context";
import type { VenueView, VenueWorkspaceProps } from "./_components/venue-workspace/types";
import { venueDashboardRouteScope } from "./dashboard-query";
import { feedbackQuery, legacyFeedbackHref, parseFeedbackAddress } from "./feedback-query";
import { CALENDAR_VIEW_COOKIE, parseCalendarView, parseShiftSelection } from "./schedule-url";
import type { VenueOverviewProps } from "./screens/VenueOverviewScreen";
import type { VenueSettingsProps } from "./screens/VenueSettingsScreen";
import type { VenueSettingsTab } from "./screens/venue-nav";

/** What a page load ends in: its props, a redirect, or an error status for the platform's error page. */
export type PageData<T> = { kind: "ok"; props: T } | { kind: "redirect"; to: string } | { kind: "error"; status: ServiceError["status"] };

const log = logger("venue:workspace");

/** The venues the overview lists per page, by name. */
export const OVERVIEW_VENUES = 100;
/** The next shifts the overview shows, and how far ahead it looks. */
export const OVERVIEW_SHIFTS = 12;
export const OVERVIEW_SHIFT_DAYS = 14;

/**
 * The person's next shifts across their venues, then a page of their venues (`q` searches them, `page` pages them),
 * each with how it stands now. Four statements whatever the number of venues and shifts: the shifts with their faces,
 * the page of venues with their permissions, their public ids, their hours.
 */
export const loadVenueOverview = async <T extends AuthContext>(c: Context<T>): Promise<PageData<VenueOverviewProps>> => {
  const actor = expectUserBackedActor(c);
  const now = new Date();
  const query = (c.req.query("q") ?? "").trim().slice(0, 200);
  const page = Math.max(1, Math.min(1000, Number.parseInt(c.req.query("page") ?? "", 10) || 1));
  const [found, shifts] = await Promise.all([
    // one more than a page says whether another page follows
    venueService.venues.discover(actor, { query, limit: OVERVIEW_VENUES + 1, offset: (page - 1) * OVERVIEW_VENUES }),
    venueService.myUpcomingShifts(actor, now, { days: OVERVIEW_SHIFT_DAYS, limit: OVERVIEW_SHIFTS }),
  ]);
  const venues = found.slice(0, OVERVIEW_VENUES);
  const [projected, states] = await Promise.all([venueService.publicResources.projectVenues(venues), venueService.openStates(venues, now)]);
  return {
    kind: "ok",
    props: {
      now: now.toISOString(),
      // the island gets what the list shows: the sign, the name and how it stands (no descriptions, no images)
      venues: projected.map((venue, index) => ({
        id: venue.id,
        name: venue.name,
        icon: venue.icon,
        accentColor: venue.accentColor,
        timezone: venue.timezone,
        state: states.get(venues[index]!.id) ?? { kind: "closed" },
      })),
      morePages: found.length > OVERVIEW_VENUES,
      page,
      shifts,
      templates: venueService.venueTemplates.list(getLocale(c)),
      initialQuery: query,
    },
  };
};

const parseCalendarDate = (value: string | null): string => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date().toISOString().slice(0, 10);
  return value;
};

const viewPath = (id: string, view: VenueView) => `/app/venue/${id}/${view}`;

type ResolvedView = { initialView: VenueView; redirectTo?: string };

/**
 * The view a URL shows the caller, or where it sends them. Feedback is for staff and admins, the Public page view
 * for admins; anyone else lands on the schedule. Section links from before the Public page view lead admins to
 * that view with the section marked.
 */
const resolveView = (
  venueId: string,
  pathView: string | undefined,
  sectionId: string | undefined,
  search: string,
  permission: { internal: boolean; admin: boolean },
): ResolvedView => {
  if (sectionId) {
    const target = permission.admin
      ? `${viewPath(venueId, "public")}?section=${encodeURIComponent(sectionId)}`
      : viewPath(venueId, "shifts");
    return { initialView: "shifts", redirectTo: target };
  }
  if (!pathView) return { initialView: "shifts", redirectTo: `${viewPath(venueId, "shifts")}${search}` };
  if (pathView === "shifts" || pathView === "my-shifts") return { initialView: pathView };
  if (pathView === "feedback" && permission.internal) return { initialView: pathView };
  if (pathView === "public" && permission.admin) return { initialView: pathView };
  return { initialView: "shifts", redirectTo: viewPath(venueId, "shifts") };
};

/** One venue's workspace: the view the address names, with everything its first picture shows. */
export const loadVenueWorkspace = async <T extends AuthContext>(
  c: Context<T>,
): Promise<PageData<VenueWorkspaceProps & { venueName: string }>> => {
  const id = c.req.param("id");
  if (!id) return { kind: "error", status: 404 };
  const url = new URL(c.req.raw.url);
  const user = expectUserBackedActor(c);
  const venueResult = await venueService.venues.resolve(id, user, "read");
  if (!venueResult.ok) return { kind: "error", status: venueResult.error.status };
  const venue = venueResult.data;

  const pathView = c.req.param("view");
  const isAdmin = venue.permission === "admin";
  const resolved = resolveView(id, pathView, c.req.param("sectionId"), url.search, {
    internal: venueService.canSeeInternal(venue),
    admin: isAdmin,
  });
  if (resolved.redirectTo) return { kind: "redirect", to: resolved.redirectTo };
  // The URL wins; without one, the view this browser used last; a first visit starts with the week.
  const urlCalendarView = parseCalendarView(url.searchParams.get("cv"));
  const cookieCalendarView = parseCalendarView(getCookie(c, CALENDAR_VIEW_COOKIE));
  const initialCalendarView = urlCalendarView ?? cookieCalendarView ?? "week";
  const initialCalendarViewSource = urlCalendarView ? "url" : cookieCalendarView ? "cookie" : "default";
  const initialCalendarDate = parseCalendarDate(url.searchParams.get("cd"));
  // The feedback list reads its address through its one declaration; old `search=` links lead to `q=`.
  const legacy = resolved.initialView === "feedback" ? legacyFeedbackHref(url.pathname, url.searchParams) : null;
  if (legacy) return { kind: "redirect", to: legacy };
  const feedback = parseFeedbackAddress(feedbackQuery(getLocale(c)), url.searchParams);
  const initialFeedbackDays = feedback.days;
  const initialFeedbackSearch = feedback.search;
  const initialFeedbackComments = feedback.comments;
  const dashboardScope = venueDashboardRouteScope({
    venueId: id,
    view: resolved.initialView,
    calendarView: initialCalendarView,
    calendarDate: initialCalendarDate,
    feedbackDays: initialFeedbackDays,
    feedbackSearch: initialFeedbackSearch,
    feedbackComments: initialFeedbackComments,
    feedbackPage: feedback.page,
  });
  // The Public page view previews the page as visitors would see it, also while it is off. A failed preview
  // leaves the rest of the view usable; the view says so and offers to retry.
  const loadPreview = async (): Promise<PublicStatus | null> => {
    try {
      return await venueService.publicResources.projectPublicStatus(await venueService.status(venue, new Date(), true, getLocale(c)));
    } catch (error) {
      log.error("Venue public page preview failed", { venueId: venue.id, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  const [internalDashboard, calendarUrl, accessEntries, publicPreview] = await Promise.all([
    venueService.dashboard(venue, user, dashboardScope.options),
    venueService.ical.getOrCreateToken(user.id).then(venueService.ical.url),
    venue.permission === "admin" ? venueService.access.list(venue.id, venue.permission) : Promise.resolve([]),
    resolved.initialView === "public" ? loadPreview() : Promise.resolve(null),
  ]);
  const dashboard = await venueService.publicResources.projectDashboard(internalDashboard);
  // `?section=` marks one section in the Public page view; a deleted or unknown one marks nothing.
  const sectionParam = url.searchParams.get("section") ?? "";
  const initialSectionId =
    resolved.initialView === "public" &&
    SHORT_ID_REGEX.test(sectionParam) &&
    dashboard.sections.some((section) => section.id === sectionParam)
      ? sectionParam
      : null;
  return {
    kind: "ok",
    props: {
      venueName: venue.name,
      dashboard,
      dashboardSource: dashboardScope.source,
      userId: user.id,
      calendarUrl,
      accessEntries,
      // API keys live on the settings page now (settings.page.tsx).
      apiKeys: [],
      initialView: resolved.initialView,
      initialSectionId,
      initialPublicPreview: publicPreview,
      initialCalendarView,
      initialCalendarViewSource,
      initialGapsOnly: url.searchParams.get("gaps") === "1",
      initialShiftId: parseShiftSelection(url.searchParams.get("shift")),
      initialCalendarDate,
      initialFeedbackDays,
      initialFeedbackSearch,
      initialFeedbackComments,
    },
  };
};

const TABS: readonly VenueSettingsTab[] = ["general", "access", "schedule", "danger"];

/** A venue's settings, for admins: `/settings` is the general tab, `/settings/<tab>` the others. */
export const loadVenueSettings = async <T extends AuthContext>(c: Context<T>): Promise<PageData<VenueSettingsProps>> => {
  const id = c.req.param("id") ?? "";
  const requested = c.req.param("tab");
  const tab = TABS.find((entry) => entry === requested);
  if (requested !== undefined && (!tab || tab === "general"))
    return { kind: "redirect", to: `/app/venue/${encodeURIComponent(id)}/settings` };
  const user = expectUserBackedActor(c);
  const resolved = await venueService.venues.resolve(id, user, "read");
  if (!resolved.ok) return { kind: "error", status: resolved.error.status };
  // Everyone else reads the venue where it works for them; the settings are the admins' own place.
  if (resolved.data.permission !== "admin") return { kind: "redirect", to: `/app/venue/${encodeURIComponent(id)}/shifts` };
  // the sidebar shows the same figures as on the venue's other pages
  const [settings, facts] = await Promise.all([loadVenueSettingsContext(resolved.data), venueService.navFacts(resolved.data, user)]);
  return { kind: "ok", props: { initial: settings, dashboard: { venue: settings.venue, ...facts }, tab: tab ?? "general" } };
};
