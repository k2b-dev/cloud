import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { notebooksService } from "../service";
import AdminNotebooksScreen from "./_components/AdminNotebooksScreen.island";
import { notebooksAdminMessages } from "./admin-messages";

const PER_PAGE = 100;

export default ssr<AuthContext>(async (c) => {
  const t = notebooksAdminMessages.resolve([getLocale(c)]).t;
  const search = (c.req.query("search") ?? "").trim();
  const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  // List + summary in parallel — summary is a single SQL aggregation across the
  // full filtered set, NOT just the visible page.
  const [notebooks, summary] = await Promise.all([
    notebooksService.notebook.admin.list({
      pagination: { page, perPage: PER_PAGE },
      filter: { query: search || undefined },
    }),
    notebooksService.notebook.admin.summary({ filter: { query: search || undefined } }),
  ]);

  return () => (
    <AdminLayout c={c} title={t.notebooks} ui="v2">
      <AdminNotebooksScreen
        nav={adminNavigation(c)}
        rows={notebooks.items.map((notebook) => ({
          id: notebook.id,
          shortId: notebook.shortId,
          name: notebook.name,
          description: notebook.description,
          icon: notebook.icon,
          permissionCount: notebook.permissionCount,
        }))}
        total={notebooks.total}
        page={notebooks.page}
        pages={Math.max(1, Math.ceil(notebooks.total / notebooks.perPage))}
        search={search}
        orphaned={summary.orphaned}
        permissions={summary.totalPermissions}
      />
    </AdminLayout>
  );
});
