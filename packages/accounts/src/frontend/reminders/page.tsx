import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Pagination, Placeholder } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { accountsAppService as accountsService } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import AccountAvatar from "@/frontend/AccountAvatar";
import { ssr } from "../../config";
import AccountsWorkspace from "../AccountsWorkspace";
import { accountsMessages } from "../messages";
import ReminderFilters from "./ReminderFilters.island";

const parsePage = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const buildUrl = (params: { search?: string; kind?: string; status?: string; page?: number }) => {
  const query = new URLSearchParams();
  if (params.search?.trim()) query.set("search", params.search.trim());
  if (params.kind?.trim()) query.set("kind", params.kind.trim());
  if (params.status?.trim()) query.set("status", params.status.trim());
  if (params.page && params.page > 1) query.set("page", String(params.page));
  const search = query.toString();
  return search ? `/app/accounts/reminders?${search}` : "/app/accounts/reminders";
};

export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const page = parsePage(c.req.query("page"));
  const perPage = 100;
  const search = (c.req.query("search") ?? "").trim();
  const kind = (c.req.query("kind") ?? "").trim();
  const status = (c.req.query("status") ?? "").trim();

  const [pendingRequestsPage, remindersPage] = await Promise.all([
    accountsService.accountRequest.list({ access: { userId: user.id, isAdmin: true }, filter: { status: "pending" } }),
    accountsService.lifecycle.reminders.list({
      page,
      perPage,
      search: search || undefined,
      kind: (kind || undefined) as "account_expiry" | undefined,
      status: status || undefined,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(remindersPage.total / perPage));
  const baseUrl = (() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (kind) params.set("kind", kind);
    if (status) params.set("status", status);
    const query = params.toString();
    return query ? `/app/accounts/reminders?${query}&page=` : "/app/accounts/reminders?page=";
  })();
  type ReminderRow = (typeof remindersPage.items)[number];
  const columns: DataTableColumn<ReminderRow>[] = [
    { id: "user", header: t.user, value: (entry) => entry.displayName || entry.uid || `(${t.deletedUser})` },
    { id: "kind", header: t.kind, value: () => t.accountExpiry },
    { id: "target", header: t.targetExpiry, value: (entry) => entry.targetExpiryAt, cellClass: "whitespace-nowrap" },
    {
      id: "status",
      header: t.status,
      value: (entry) => (entry.status === "pending" ? t.pending : entry.status === "sent" ? t.sent : t.error),
    },
    { id: "attempts", header: t.attempts, value: (entry) => entry.attemptCount },
    { id: "lastAttempt", header: t.lastAttempt, value: (entry) => entry.lastAttemptAt, cellClass: "whitespace-nowrap" },
  ];

  return () => (
    <Layout
      c={c}
      fullWidth
      title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.reminderHistory }]}
    >
      <AccountsWorkspace active="reminders" isAdmin pendingRequests={pendingRequestsPage.total} scrollPreserveKey="accounts-reminders">
        <div class="flex flex-col gap-2">
          <div class="min-w-0" style="view-transition-name: accounts-reminders-title">
            <h1 class="text-base font-semibold text-primary">{t.reminderHistory}</h1>
            <p class="mt-1 text-xs text-dimmed">{t.entryCount({ count: remindersPage.total })}</p>
          </div>

          <div style="view-transition-name: accounts-reminders-search">
            <SearchBar
              action={buildUrl({ status, kind, page: 1 })}
              value={search}
              placeholder={t.searchReminders}
              ariaLabel={t.searchReminders}
            />
          </div>

          <div class="flex flex-wrap items-center gap-2" style="view-transition-name: accounts-reminders-filters">
            <ReminderFilters search={search} status={status} kind={kind} />
          </div>

          {remindersPage.items.length === 0 ? (
            <Placeholder surface="paper" description={<>{t.noReminders}</>} />
          ) : (
            <div class="paper overflow-hidden" style="view-transition-name: accounts-reminders-table">
              <DataTable
                rows={remindersPage.items}
                columns={columns}
                getRowId={(entry) => entry.id}
                hoverRows
                class="overflow-x-auto"
                scrollPreserveKey="accounts-reminders-table"
                renderCell={({ row: entry, col }) => {
                  if (col.id === "user") {
                    const label = entry.displayName || entry.uid || `(${t.deletedUser})`;
                    return (
                      <div class="flex min-w-0 items-center gap-2">
                        <AccountAvatar name={label} userId={entry.userId} avatarHash={entry.avatarHash} size="xs" />
                        <div class="min-w-0 flex-1">
                          <div class="truncate font-medium text-primary">{label}</div>
                          {entry.lastError ? (
                            <div class="truncate text-[11px] text-red-500" title={entry.lastError}>
                              {entry.lastError}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  }
                  if (col.id === "kind") return <span class="text-dimmed">{t.accountExpiry}</span>;
                  if (col.id === "target")
                    return (
                      <span class="text-dimmed">
                        {dates.formatDateTime(entry.targetExpiryAt, { locale })} · {t.daysShort({ count: entry.thresholdDays })}
                      </span>
                    );
                  if (col.id === "status") {
                    const label = entry.status === "pending" ? t.pending : entry.status === "sent" ? t.sent : t.error;
                    return <span class="text-dimmed">{label}</span>;
                  }
                  if (col.id === "attempts") return <span class="text-dimmed">{entry.attemptCount}</span>;
                  if (col.id === "lastAttempt")
                    return (
                      <span class="text-dimmed">{entry.lastAttemptAt ? dates.formatDateTime(entry.lastAttemptAt, { locale }) : "-"}</span>
                    );
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
