import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Pagination, Placeholder } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { accountsAppService as accountsService, type NotificationBatch, notificationBatches } from "@valentinkolb/cloud/services";
import { formatNumber } from "@valentinkolb/cloud/shared";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import AccountsWorkspace from "../AccountsWorkspace";
import { accountsMessages } from "../messages";
import NewNotificationBatch from "./NewNotificationBatch.island";
import NotificationBatchStatusFilters from "./NotificationBatchStatusFilters.island";

const MAX_PAGE = 10_000;

const parsePage = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE) : 1;
};

const validStatus = (value: string | undefined): NotificationBatch["status"] | undefined => {
  if (
    value === "draft" ||
    value === "ready" ||
    value === "running" ||
    value === "completed" ||
    value === "completed_with_errors" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return undefined;
};

const buildUrl = (params: { status?: string; page?: number }) => {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.page && params.page > 1) query.set("page", String(params.page));
  const search = query.toString();
  return search ? `/app/accounts/notifications?${search}` : "/app/accounts/notifications";
};

const statusClass = (status: NotificationBatch["status"]) => {
  if (status === "completed") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (status === "completed_with_errors" || status === "failed") return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
  if (status === "running" || status === "ready") return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
  return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
};

export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const statusLabel = (value: NotificationBatch["status"]) =>
    ({
      draft: t.draft,
      ready: t.ready,
      running: t.running,
      completed: t.completed,
      completed_with_errors: t.withErrors,
      failed: t.failed,
      cancelled: t.cancelled,
    })[value];
  const user = expectUserBackedActor(c);
  const page = parsePage(c.req.query("page"));
  const perPage = 50;
  const status = validStatus(c.req.query("status"));

  const [pendingRequestsPage, batchesPage] = await Promise.all([
    accountsService.accountRequest.list({ access: { userId: user.id, isAdmin: true }, filter: { status: "pending" } }),
    notificationBatches.list({ page, perPage, status }),
  ]);
  const totalPages = Math.max(1, Math.ceil(batchesPage.total / perPage));
  const baseUrl = buildUrl({ status, page: 1 }).includes("?")
    ? `${buildUrl({ status, page: 1 })}&page=`
    : "/app/accounts/notifications?page=";

  const columns: DataTableColumn<NotificationBatch>[] = [
    { id: "subject", header: t.subject, value: (entry) => entry.subject, cellClass: "min-w-[18rem]" },
    { id: "status", header: t.status, value: (entry) => entry.status },
    { id: "targets", header: t.recipients, value: (entry) => entry.targetCount },
    { id: "sent", header: t.sent, value: (entry) => entry.sentCount },
    { id: "errors", header: t.errors, value: (entry) => entry.errorCount },
    { id: "created", header: t.created, value: (entry) => entry.createdAt, cellClass: "whitespace-nowrap" },
  ];

  return () => (
    <Layout
      c={c}
      fullWidth
      title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.notifications }]}
    >
      <AccountsWorkspace
        active="notifications"
        isAdmin
        pendingRequests={pendingRequestsPage.total}
        scrollPreserveKey="accounts-notifications"
      >
        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-start gap-3" style="view-transition-name: accounts-notifications-title">
            <div class="min-w-0 flex-1">
              <h1 class="text-base font-semibold text-primary">{t.notifications}</h1>
              <p class="mt-1 text-xs text-dimmed">{t.notificationBatchCount({ count: batchesPage.total })}</p>
            </div>
            <NewNotificationBatch />
          </div>

          <div class="flex flex-wrap items-center gap-2" style="view-transition-name: accounts-notifications-filters">
            <NotificationBatchStatusFilters status={status ?? ""} />
          </div>

          {batchesPage.items.length === 0 ? (
            <Placeholder
              surface="paper"
              description={<>{status ? t.noNotificationBatchesStatus({ status }) : t.noNotificationBatches}</>}
            />
          ) : (
            <div class="paper overflow-hidden" style="view-transition-name: accounts-notifications-table">
              <DataTable
                rows={batchesPage.items}
                columns={columns}
                getRowId={(entry) => entry.id}
                hoverRows
                class="overflow-x-auto"
                scrollPreserveKey="accounts-notifications-table"
                renderCell={({ row: entry, col }) => {
                  const href = `/app/accounts/notifications/${entry.id}`;
                  if (col.id === "subject") {
                    return (
                      <a href={href} class="block min-w-0">
                        <span class="block truncate font-medium text-primary hover:underline">{entry.subject}</span>
                        <span class="block truncate text-[11px] text-dimmed">{entry.lastError ?? t.emailBatch}</span>
                      </a>
                    );
                  }
                  if (col.id === "status") {
                    return (
                      <span class={`w-fit rounded px-1.5 py-0.5 text-[10px] font-medium ${statusClass(entry.status)}`}>
                        {statusLabel(entry.status)}
                      </span>
                    );
                  }
                  if (col.id === "targets")
                    return (
                      <span class="text-dimmed">
                        {t.deliverableRatio({
                          deliverable: formatNumber(entry.deliverableCount, { locale }),
                          total: formatNumber(entry.targetCount, { locale }),
                        })}
                      </span>
                    );
                  if (col.id === "sent") return <span class="text-dimmed">{formatNumber(entry.sentCount, { locale })}</span>;
                  if (col.id === "errors")
                    return (
                      <span class={entry.errorCount > 0 ? "text-red-600" : "text-dimmed"}>
                        {formatNumber(entry.errorCount, { locale })}
                      </span>
                    );
                  if (col.id === "created") return <span class="text-dimmed">{dates.formatDateTime(entry.createdAt, { locale })}</span>;
                  return "";
                }}
              />
            </div>
          )}

          <div class="pt-1">
            <Pagination currentPage={page} totalPages={totalPages} baseUrl={baseUrl} />
          </div>
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
