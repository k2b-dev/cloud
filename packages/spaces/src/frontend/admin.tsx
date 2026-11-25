import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { spacesService } from "../service";
import { spacesPublicResources } from "../service/public-resources";
import AdminSpaces from "./_components/AdminSpaces.island";
import { adminMessages } from "./admin-messages";

const PER_PAGE = 100;

/** Spaces in the administration on v2: the server reads the page and the counts of the whole filtered set. */
export default ssr<AuthContext>(async (c) => {
  const { t } = adminMessages.resolve([getLocale(c)]);
  const search = (c.req.query("search") ?? "").trim();
  const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  // List + summary in parallel — summary is a single SQL aggregation across the full filtered set, NOT the page.
  const [spaces, summary] = await Promise.all([
    spacesService.space.admin.list({ pagination: { page, perPage: PER_PAGE }, filter: { query: search || undefined } }),
    spacesService.space.admin.summary({ filter: { query: search || undefined } }),
  ]);
  const items = await spacesPublicResources.projectSpaces(spaces.items);

  return () => (
    <AdminLayout c={c} ui="v2" title={t.spaces}>
      <AdminSpaces
        nav={adminNavigation(c)}
        rows={items.map((space) => ({
          id: space.id,
          name: space.name,
          description: space.description,
          permissionCount: space.permissionCount,
        }))}
        search={search}
        page={spaces.page}
        totalPages={Math.ceil(spaces.total / spaces.perPage)}
        total={spaces.total}
        orphaned={summary.orphaned}
        accessEntries={summary.totalPermissions}
      />
    </AdminLayout>
  );
});
