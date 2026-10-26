import { type AuthContext, getLocale, getTimeZone } from "@k2b/cloud/server";
import { AccountIdentityError } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { FilegateError } from "@k2b/filegate";
import { ssr } from "../config";
import { requestCall } from "../files-call";
import { FilesError, filesService } from "../service";
import AdminWorkspace from "./AdminWorkspace.island";
import { adminActivityHref, loadAdminBaseLabels, parseAdminActivityFilters } from "./admin-history";
import { AdminLocationSchema, type AdminSnapshot, adminHref } from "./admin-location";
import { adminMessages } from "./admin-messages";
import { activityRequest } from "./history-requests";
import { filesMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = filesMessages.resolve([getLocale(c)]);
  const { t: a } = adminMessages.resolve([getLocale(c)]);
  const query = AdminLocationSchema.safeParse(c.req.query());
  if (!query.success) return ssr.error(c, 400);
  const location = query.data;
  const activityFilters = location.view === "activity" ? parseAdminActivityFilters(new URL(c.req.url).searchParams) : undefined;
  if (activityFilters === null) return ssr.error(c, 400);
  const timeZone = getTimeZone(c);
  let initial: AdminSnapshot;
  try {
    const result = await filesService.admin(requestCall(c), {
      includeEntries: location.view === "directories" && !location.name && !location.archiveId ? "true" : "false",
      area: location.area,
      kind: location.kind,
      q: location.q,
      status: location.status,
      after: location.view === "directories" && !location.name ? location.after : undefined,
    });
    initial = { source: activityFilters ? adminActivityHref(activityFilters) : adminHref(location), result, archives: null, browse: null };
    if (!result.issue && (location.name || location.archiveId))
      initial.browse = await filesService.adminList(requestCall(c), {
        area: location.area,
        kind: location.kind,
        name: location.name,
        archiveId: location.archiveId,
        path: location.path,
        after: location.after,
      });
    else if (!result.issue && location.view === "archive")
      initial.archives = await filesService.archives(requestCall(c), {
        area: location.area,
        q: location.q,
        after: location.after,
      });
    if (location.view === "shares") {
      initial.shares = await filesService.listShares(requestCall(c), { admin: true });
      initial.uploads = await filesService.adminUploadReservations(requestCall(c));
    }
    if (activityFilters) {
      initial.now = new Date().toISOString();
      initial.activityBases = await filesService
        .adminActivityBases({ ...requestCall(c), locale: getLocale(c), requestAbort: c.req.raw.signal })
        .catch(() => null);
      // The same request as the view's own loader; a failed first page leaves the view to load and report it itself.
      initial.activity = await filesService
        .activity({ ...requestCall(c), requestAbort: c.req.raw.signal }, activityRequest(activityFilters, { now: initial.now, timeZone }))
        .then((page) => ({ filters: activityFilters, page }))
        .catch(() => null);
      initial.activityBaseLabels = await loadAdminBaseLabels(
        initial.activity?.page.items ?? [],
        initial.activityBases?.items ?? [],
        activityFilters.baseId,
        (input, signal) => filesService.adminActivityBases({ ...requestCall(c), locale: getLocale(c), requestAbort: signal }, input),
        c.req.raw.signal,
      ).catch(() => initial.activityBases?.items ?? []);
    }
  } catch (error) {
    if (error instanceof FilesError || error instanceof AccountIdentityError)
      return ssr.error(c, error.status, { description: error.status === 404 ? a.missingHint : a.connectionHint });
    if (error instanceof FilegateError)
      return ssr.error(c, error.status === 404 ? 404 : 503, { description: error.status === 404 ? a.missingHint : a.connectionHint });
    throw error;
  }
  return () => (
    <AdminLayout c={c} title={t.admin} scroll={false}>
      <AdminWorkspace initial={initial} timeZone={timeZone} />
    </AdminLayout>
  );
});
