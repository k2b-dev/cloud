import { type AuthContext, getDateConfig, getLocale, getTimeZone } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { app, ssr } from "../config";
import { notebooksService } from "../service";
import type { AdminNotebookDetail, AdminNotebookPrincipal } from "./_components/AdminNotebooksScreen";
import AdminNotebooksScreen from "./_components/AdminNotebooksScreen.island";
import { notebooksAdminMessages } from "./admin-messages";

const PER_PAGE = 100;
/** How many access entries and events the open notebook shows; the access section counts them all. */
const DETAIL_ACCESS = 50;
const DETAIL_HISTORY = 8;

type Window = { timeZone: string; now: Date };

/** The open notebook (`?open=<short id>`) with what its detail shows; none when the address names no notebook. */
const loadDetail = async (shortId: string | undefined, window: Window): Promise<AdminNotebookDetail | undefined> => {
  if (!shortId) return undefined;
  const notebook = await notebooksService.notebook.getByShortId({ shortId });
  if (!notebook) return undefined;
  const [[activity], writers, access, history] = await Promise.all([
    notebooksService.notebook.admin.activity({ notebookIds: [notebook.id], ...window }),
    notebooksService.notebook.admin.writers({ notebookId: notebook.id, ...window }),
    notebooksService.notebook.access.list({ notebookId: notebook.id, pagination: { page: 1, perPage: DETAIL_ACCESS } }),
    // the administration reads every notebook's history, as it manages every notebook's access
    notebooksService.activity.list({ bypassAccess: true, notebookId: notebook.id, limit: DETAIL_HISTORY }),
  ]);
  return {
    shortId: notebook.shortId,
    name: notebook.name,
    icon: notebook.icon,
    description: notebook.description,
    createdAt: notebook.createdAt,
    noteCount: activity?.noteCount ?? 0,
    lastActivityAt: activity?.lastActivityAt ?? null,
    changesPerDay: activity?.changesPerDay ?? [],
    access: access.items.map((entry) => ({
      principal: {
        kind: entry.principal.type === "public" ? "authenticated" : entry.principal.type,
        id:
          entry.principal.type === "user"
            ? entry.principal.userId
            : entry.principal.type === "group"
              ? entry.principal.groupId
              : entry.principal.type === "service_account"
                ? entry.principal.serviceAccountId
                : null,
        name: entry.displayName ?? "",
        avatarHash: entry.avatarHash ?? null,
      },
      permission: entry.permission,
    })),
    accessTotal: access.total,
    writers,
    history: history.items.map((event) => ({
      id: event.id,
      actor: {
        kind: event.actor.kind === "system" ? "service_account" : event.actor.kind,
        id: event.actor.id,
        name: event.actor.displayName,
        avatarHash: event.actor.avatarHash,
      } satisfies AdminNotebookPrincipal,
      action: event.action,
      noteTitle: event.note?.title ?? null,
      at: event.lastOccurredAt,
    })),
  };
};

export default ssr<AuthContext>(async (c) => {
  const t = notebooksAdminMessages.resolve([getLocale(c)]).t;
  const search = (c.req.query("search") ?? "").trim();
  const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  // one moment and one time zone for the activity's days and for the relative times, so the server's page and the
  // browser's agree
  const window: Window = { timeZone: getTimeZone(c), now: new Date() };

  // List + summary in parallel — summary is a single SQL aggregation across the
  // full filtered set, NOT just the visible page.
  const [notebooks, summary, detail] = await Promise.all([
    notebooksService.notebook.admin.list({
      pagination: { page, perPage: PER_PAGE },
      filter: { query: search || undefined },
    }),
    notebooksService.notebook.admin.summary({ filter: { query: search || undefined }, ...window }),
    loadDetail(c.req.query("open"), window),
  ]);
  // the page's notebooks: their size, their last change and the first who have access, in one statement
  const activity = new Map(
    (await notebooksService.notebook.admin.activity({ notebookIds: notebooks.items.map((notebook) => notebook.id), ...window })).map(
      (item) => [item.notebookId, item],
    ),
  );

  return () => (
    <AdminLayout c={c} title={t.notebooks} ui="v2">
      <AdminNotebooksScreen
        nav={adminNavigation(c)}
        color={app.meta.appearance?.accent}
        rows={notebooks.items.map((notebook) => ({
          id: notebook.id,
          shortId: notebook.shortId,
          name: notebook.name,
          icon: notebook.icon,
          permissionCount: notebook.permissionCount,
          noteCount: activity.get(notebook.id)?.noteCount ?? 0,
          lastActivityAt: activity.get(notebook.id)?.lastActivityAt ?? null,
          access: activity.get(notebook.id)?.access ?? [],
        }))}
        total={notebooks.total}
        page={notebooks.page}
        pages={Math.max(1, Math.ceil(notebooks.total / notebooks.perPage))}
        search={search}
        summary={{
          orphaned: summary.orphaned,
          active: summary.active,
          activePerDay: summary.activePerDay,
          orphanedNames: summary.orphanedNames,
          quietNames: summary.quietNames,
        }}
        detail={detail}
        dateConfig={getDateConfig(c)}
        now={window.now.toISOString()}
      />
    </AdminLayout>
  );
});
