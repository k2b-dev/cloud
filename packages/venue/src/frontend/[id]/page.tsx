import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { logger, serviceAccountCredentials } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { getCookie } from "hono/cookie";
import { ssr } from "../../config";
import type { PublicStatus } from "../../contracts";
import { SHORT_ID_REGEX } from "../../lib/short-id";
import { venueMessages } from "../../messages";
import { venueService } from "../../service";
import VenueWorkspace from "../_components/VenueWorkspace.island";
import type { VenueView } from "../_components/venue-workspace/types";
import { venueDashboardRouteScope } from "../dashboard-query";
import { CALENDAR_VIEW_COOKIE, parseCalendarView, parseShiftSelection } from "../schedule-url";

const log = logger("venue:workspace");

const feedbackDaysOptions = [7, 14, 30] as const;
type FeedbackDays = (typeof feedbackDaysOptions)[number];

const parseCalendarDate = (value: string | null): string => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date().toISOString().slice(0, 10);
  return value;
};

const viewPath = (id: string, view: VenueView) => `/app/venue/${id}/${view}`;
const parseFeedbackDays = (value: string | null): FeedbackDays => {
  const parsed = Number(value);
  return feedbackDaysOptions.includes(parsed as FeedbackDays) ? (parsed as FeedbackDays) : 30;
};
/** A positive page number; the service clamps it to the last page. */
const parsePage = (value: string | null): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : 1;
};

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

export default ssr<AuthContext>(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  const id = c.req.param("id");
  if (!id) return ssr.error(c, 404);
  const url = new URL(c.req.raw.url);
  const user = expectUserBackedActor(c);
  const venueResult = await venueService.venues.resolve(id, user, "read");
  if (!venueResult.ok) return ssr.error(c, venueResult.error.status);
  const venue = venueResult.data;

  const pathView = c.req.param("view");
  const isAdmin = venue.permission === "admin";
  const resolved = resolveView(id, pathView, c.req.param("sectionId"), url.search, {
    internal: venueService.canSeeInternal(venue),
    admin: isAdmin,
  });
  if (resolved.redirectTo) return c.redirect(resolved.redirectTo);
  // The URL wins; without one, the view this browser used last; a first visit starts with the week.
  const urlCalendarView = parseCalendarView(url.searchParams.get("cv"));
  const cookieCalendarView = parseCalendarView(getCookie(c, CALENDAR_VIEW_COOKIE));
  const initialCalendarView = urlCalendarView ?? cookieCalendarView ?? "week";
  const initialCalendarViewSource = urlCalendarView ? "url" : cookieCalendarView ? "cookie" : "default";
  const initialCalendarDate = parseCalendarDate(url.searchParams.get("cd"));
  const initialFeedbackDays = parseFeedbackDays(url.searchParams.get("days"));
  const initialFeedbackSearch = (url.searchParams.get("search") ?? "").trim();
  const initialFeedbackComments = url.searchParams.get("comments") === "1";
  const dashboardScope = venueDashboardRouteScope({
    venueId: id,
    view: resolved.initialView,
    calendarView: initialCalendarView,
    calendarDate: initialCalendarDate,
    feedbackDays: initialFeedbackDays,
    feedbackSearch: initialFeedbackSearch,
    feedbackComments: initialFeedbackComments,
    feedbackPage: parsePage(url.searchParams.get("page")),
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
  const [internalDashboard, calendarUrl, accessEntries, apiKeyOverview, publicPreview] = await Promise.all([
    venueService.dashboard(venue, user, dashboardScope.options),
    venueService.ical.getOrCreateToken(user.id).then(venueService.ical.url),
    venue.permission === "admin" ? venueService.access.list(venue.id) : Promise.resolve([]),
    venue.permission === "admin"
      ? serviceAccountCredentials.listOverview({
          pagination: { page: 1, perPage: 500 },
          filter: {
            serviceAccountKind: "resource_bound",
            credentialStatus: "active",
            appId: "venue",
            resourceType: "venue",
            resourceId: venue.id,
          },
        })
      : Promise.resolve({ items: [] }),
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
  const permissionByServiceAccountId = new Map(
    accessEntries
      .filter((entry) => entry.principal.type === "service_account")
      .map((entry) => [(entry.principal as { type: "service_account"; serviceAccountId: string }).serviceAccountId, entry.permission]),
  );
  const apiKeys: ResourceApiKey[] = apiKeyOverview.items.map((item) => {
    const permission = permissionByServiceAccountId.get(item.serviceAccount.id) ?? "none";
    const { serviceAccount: _serviceAccount, owner: _owner, ...credential } = item;
    return { ...credential, permission };
  });

  return () => (
    <Layout
      c={c}
      title={[{ title: t.start, href: "/" }, { title: t.appName, href: "/app/venue" }, { title: venue.name }]}
      fullWidth
      fullPage
    >
      <VenueWorkspace
        dashboard={dashboard}
        dashboardSource={dashboardScope.source}
        userId={user.id}
        calendarUrl={calendarUrl}
        accessEntries={accessEntries}
        apiKeys={apiKeys}
        initialView={resolved.initialView}
        initialSectionId={initialSectionId}
        initialPublicPreview={publicPreview}
        initialCalendarView={initialCalendarView}
        initialCalendarViewSource={initialCalendarViewSource}
        initialGapsOnly={url.searchParams.get("gaps") === "1"}
        initialShiftId={parseShiftSelection(url.searchParams.get("shift"))}
        initialCalendarDate={initialCalendarDate}
        initialFeedbackDays={initialFeedbackDays}
        initialFeedbackSearch={initialFeedbackSearch}
        initialFeedbackComments={initialFeedbackComments}
      />
    </Layout>
  );
});
