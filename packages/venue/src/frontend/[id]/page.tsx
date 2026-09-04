import type { CalendarView } from "@k2b/ui";
import type { ResourceApiKey } from "@valentinkolb/cloud/access/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { serviceAccountCredentials } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import { venueService } from "../../service";
import { venueMessages } from "../../messages";
import VenueWorkspace from "../_components/VenueWorkspace.island";
import { venueDashboardRouteScope } from "../dashboard-query";

const calendarViews: CalendarView[] = ["week", "month"];
const feedbackDaysOptions = [7, 14, 30] as const;
type FeedbackDays = (typeof feedbackDaysOptions)[number];

const parseCalendarDate = (value: string | null): string => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date().toISOString().slice(0, 10);
  return value;
};

const viewPath = (id: string, view: "shifts" | "my-shifts" | "feedback") => `/app/venue/${id}/${view}`;
const parseFeedbackDays = (value: string | null): FeedbackDays => {
  const parsed = Number(value);
  return feedbackDaysOptions.includes(parsed as FeedbackDays) ? (parsed as FeedbackDays) : 30;
};

type ResolvedView = {
  initialView: "shifts" | "my-shifts" | "feedback";
  initialSectionId: string | null;
  redirectTo?: string;
};

const resolveView = (venueId: string, pathView: string | undefined, sectionId: string | undefined, search: string): ResolvedView => {
  const initialSectionId = sectionId ?? null;
  if (!pathView && !initialSectionId)
    return { initialView: "shifts", initialSectionId, redirectTo: `${viewPath(venueId, "shifts")}${search}` };
  if (pathView === "my-shifts" || pathView === "feedback" || pathView === "shifts") return { initialView: pathView, initialSectionId };
  if (pathView) return { initialView: "shifts", initialSectionId, redirectTo: viewPath(venueId, "shifts") };
  return { initialView: "shifts", initialSectionId };
};

export default ssr<AuthContext>(async (c) => {
  const { t } = venueMessages.resolve([getLocale(c)]);
  const id = c.req.param("id");
  if (!id) return ssr.error(c, 404);
  const url = new URL(c.req.raw.url);
  const user = expectUserBackedActor(c);
  const venue = await venueService.venues.getByShortId(id, user);

  if (!venue) return ssr.error(c, 404);

  const access = await venueService.access.require(venue.id, user, "read");
  if (!access.ok) return ssr.error(c, access.error.status);

  const pathView = c.req.param("view");
  const resolved = resolveView(id, pathView, c.req.param("sectionId"), url.search);
  if (resolved.redirectTo) return c.redirect(resolved.redirectTo);
  const calendarViewParam = url.searchParams.get("cv") as CalendarView | null;
  const initialCalendarView = calendarViewParam && calendarViews.includes(calendarViewParam) ? calendarViewParam : "week";
  const initialCalendarDate = parseCalendarDate(url.searchParams.get("cd"));
  const initialFeedbackDays = parseFeedbackDays(url.searchParams.get("days"));
  const initialFeedbackSearch = (url.searchParams.get("search") ?? "").trim();
  const dashboardScope = venueDashboardRouteScope({
    venueId: id,
    view: resolved.initialView,
    calendarView: initialCalendarView,
    calendarDate: initialCalendarDate,
    feedbackDays: initialFeedbackDays,
    feedbackSearch: initialFeedbackSearch,
  });
  const [internalDashboard, icalToken, accessEntries, apiKeyOverview] = await Promise.all([
    venueService.dashboard(venue, user, dashboardScope.options),
    venueService.ical.getOrCreateToken(user.id),
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
  ]);
  const dashboard = await venueService.publicResources.projectDashboard(internalDashboard);
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
        icalToken={icalToken}
        accessEntries={accessEntries}
        apiKeys={apiKeys}
        initialView={resolved.initialView}
        initialSectionId={resolved.initialSectionId}
        initialCalendarView={initialCalendarView}
        initialCalendarDate={initialCalendarDate}
        initialFeedbackDays={initialFeedbackDays}
        initialFeedbackSearch={initialFeedbackSearch}
      />
    </Layout>
  );
});
