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
/** Who reads the page: their access subject, as every permission-aware read of Notebooks takes it. */
type Viewer = { userId: string | null; serviceAccountId: string | null };

/** The open notebook (`?open=<short id>`) with what its detail shows; none when the address names no notebook. */
const loadDetail = async (shortId: string | undefined, window: Window, viewer: Viewer): Promise<AdminNotebookDetail | undefined> => {
  if (!shortId) return undefined;
  const notebook = await notebooksService.notebook.getByShortId({ shortId });
  if (!notebook) return undefined;
  // The history names notes, so it is read through the viewer's own access to this notebook, like every reader of
  // Notebooks: the permission the notebook's grants give them (`getNotebookPermission`) and the history visible to them
  // (`activity.list`). The administration's role adds none; without a grant the detail shows figures, no note titles.
  const [[activity], writers, access, permission] = await Promise.all([
    notebooksService.notebook.admin.activity({ notebookIds: [notebook.id], ...window }),
    notebooksService.notebook.admin.writers({ notebookId: notebook.id, ...window }),
    notebooksService.notebook.access.list({ notebookId: notebook.id, pagination: { page: 1, perPage: DETAIL_ACCESS } }),
    notebooksService.notebook.permission.get({ notebookId: notebook.id, ...viewer }),
  ]);
  const historyVisible = permission !== "none";
  const history = historyVisible
    ? await notebooksService.activity.list({ ...viewer, notebookId: notebook.id, limit: DETAIL_HISTORY })
    : { items: [] };
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
    historyVisible,
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
  const accessSubject = c.get("accessSubject");

  // List + summary in parallel — summary is a single SQL aggregation across the
  // full filtered set, NOT just the visible page.
  const [notebooks, summary, detail] = await Promise.all([
    notebooksService.notebook.admin.list({
      pagination: { page, perPage: PER_PAGE },
      filter: { query: search || undefined },
    }),
    notebooksService.notebook.admin.summary({ filter: { query: search || undefined }, ...window }),
    loadDetail(c.req.query("open"), window, {
      userId: accessSubject.type === "user" ? accessSubject.userId : null,
      serviceAccountId: accessSubject.type === "service_account" ? accessSubject.serviceAccountId : null,
    }),
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
