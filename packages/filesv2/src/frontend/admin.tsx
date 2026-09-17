import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AccountIdentityError } from "@k2b/cloud/services";
import { AdminLayout } from "@k2b/cloud/ssr";
import { FilegateError } from "@k2b/filegate";
import { ssr } from "../config";
import { FilesError, filesService } from "../service";
import AdminWorkspace from "./AdminWorkspace.island";
import { AdminLocationSchema, type AdminSnapshot, adminHref } from "./admin-location";
import { adminMessages } from "./admin-messages";
import { filesMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = filesMessages.resolve([getLocale(c)]);
  const { t: a } = adminMessages.resolve([getLocale(c)]);
  const query = AdminLocationSchema.safeParse(c.req.query());
  if (!query.success) return ssr.error(c, 400);
  const location = query.data;
  const actor = c.get("actor");
  let initial: AdminSnapshot;
  try {
    const result = await filesService.admin(actor, {
      includeEntries: location.view === "directories" && !location.name && !location.archiveId ? "true" : "false",
      area: location.area,
      kind: location.kind,
      q: location.q,
      status: location.status,
      after: location.view === "directories" && !location.name ? location.after : undefined,
    });
    initial = { source: adminHref(location), result, archives: null, browse: null };
    if (!result.issue && (location.name || location.archiveId))
      initial.browse = await filesService.adminList(actor, {
        area: location.area,
        kind: location.kind,
        name: location.name,
        archiveId: location.archiveId,
        path: location.path,
        after: location.after,
      });
    else if (!result.issue && location.view === "archive")
      initial.archives = await filesService.archives(actor, {
        area: location.area,
        q: location.q,
        after: location.after,
      });
  } catch (error) {
    if (error instanceof FilesError || error instanceof AccountIdentityError)
      return ssr.error(c, error.status, { description: error.status === 404 ? a.missingHint : a.connectionHint });
    if (error instanceof FilegateError)
      return ssr.error(c, error.status === 404 ? 404 : 503, { description: error.status === 404 ? a.missingHint : a.connectionHint });
    throw error;
  }
  return () => (
    <AdminLayout c={c} title={t.admin} scroll={false}>
      <AdminWorkspace initial={initial} />
    </AdminLayout>
  );
});
