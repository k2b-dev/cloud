import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Pagination, Paper, Placeholder } from "@k2b/ui";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { ssr } from "../../config";
import AccountsWorkspace from "../AccountsWorkspace";
import { accountsMessages } from "../messages";
import DeletedAccountDetails from "./DeletedAccountDetails.island";
import DeletedAccountsFilters from "./DeletedAccountsFilters.island";

const parsePage = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const buildUrl = (params: { search?: string; reason?: string; page?: number }) => {
  const query = new URLSearchParams();
  if (params.search?.trim()) query.set("search", params.search.trim());
  if (params.reason?.trim()) query.set("reason", params.reason.trim());
  if (params.page && params.page > 1) query.set("page", String(params.page));
  const search = query.toString();
  return search ? `/app/accounts/deleted-accounts?${search}` : "/app/accounts/deleted-accounts";
};

export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const formatReason = (reason: string): string =>
    ({
      ipa_expired_demoted: t.deletedReasonIpaDemoted,
      ipa_expired_deleted: t.deletedReasonIpaDeleted,
      sync_out_of_scope_demoted: t.deletedReasonSyncDemoted,
      sync_out_of_scope_deleted: t.deletedReasonSyncDeleted,
      guest_expired_deleted: t.deletedReasonGuestExpired,
      local_user_expired_deleted: t.deletedReasonLocalExpired,
      manual_demote: t.deletedReasonManualDemote,
      manual_delete: t.deletedReasonManualDelete,
    })[reason] ?? reason;
  const user = expectUserBackedActor(c);
  const page = parsePage(c.req.query("page"));
  const perPage = 100;
  const search = (c.req.query("search") ?? "").trim();
  const reason = (c.req.query("reason") ?? "").trim();

  const [pendingRequestsPage, deletedAccountsPage] = await Promise.all([
    accountsService.accountRequest.list({ access: { userId: user.id, isAdmin: true }, filter: { status: "pending" } }),
    accountsService.lifecycle.deletedAccounts.list({
      page,
      perPage,
      search: search || undefined,
      reason: reason || undefined,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(deletedAccountsPage.total / perPage));
  const baseUrl = (() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (reason) params.set("reason", reason);
    const query = params.toString();
    return query ? `/app/accounts/deleted-accounts?${query}&page=` : "/app/accounts/deleted-accounts?page=";
  })();
  type DeletedAccountRow = (typeof deletedAccountsPage.items)[number];
  const columns: DataTableColumn<DeletedAccountRow>[] = [
    { id: "account", header: t.account, value: (entry) => entry.displayName || entry.uid },
    { id: "email", header: t.email, value: (entry) => entry.mail, cellClass: "max-w-[18rem]" },
    { id: "provider", header: t.provider, value: (entry) => entry.previousProvider },
    { id: "profile", header: t.profile, value: (entry) => entry.previousProfile },
    { id: "reason", header: t.reason, value: (entry) => formatReason(entry.reason) },
    { id: "deleted", header: t.deleted, value: (entry) => entry.deletedAt, cellClass: "whitespace-nowrap" },
    { id: "details", header: t.details, headerClass: "text-right", cellClass: "text-right whitespace-nowrap max-w-none" },
  ];

  return () => (
    <Layout
      c={c}
      fullWidth
      title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.deletedAccounts }]}
    >
      <AccountsWorkspace active="deleted-accounts" isAdmin pendingRequests={pendingRequestsPage.total} scrollPreserveKey="accounts-deleted">
        <div class="flex flex-col gap-2">
          <div class="min-w-0" style="view-transition-name: accounts-deleted-title">
            <h1 class="text-base font-semibold text-primary">{t.deletedAccounts}</h1>
            <p class="mt-1 text-xs text-dimmed">{t.deletedAccountCount({ count: deletedAccountsPage.total })}</p>
          </div>

          <div style="view-transition-name: accounts-deleted-search">
            <SearchBar
              action={buildUrl({ reason, page: 1 })}
              value={search}
              placeholder={t.searchDeletedAccounts}
              ariaLabel={t.searchDeletedAccounts}
            />
          </div>

          <div class="flex flex-wrap items-center gap-2" style="view-transition-name: accounts-deleted-filters">
            <DeletedAccountsFilters search={search} reason={reason} />
          </div>

          {deletedAccountsPage.items.length === 0 ? (
            <Placeholder surface="paper" description={<>{t.noDeletedAccounts}</>} />
          ) : (
            <Paper class="overflow-hidden" style="view-transition-name: accounts-deleted-table">
              <DataTable
                rows={deletedAccountsPage.items}
                columns={columns}
                getRowId={(entry) => entry.id}
                hoverRows
                class="overflow-x-auto"
                scrollPreserveKey="accounts-deleted-table"
                renderCell={({ row: entry, col }) => {
                  if (col.id === "account") return <span class="font-medium text-primary">{entry.displayName || entry.uid}</span>;
                  if (col.id === "email")
                    return (
                      <span class="truncate text-dimmed" title={entry.mail || "-"}>
                        {entry.mail || "-"}
                      </span>
                    );
                  if (col.id === "provider") return <span class="text-dimmed">{entry.previousProvider || "-"}</span>;
                  if (col.id === "profile") return <span class="text-dimmed">{entry.previousProfile || "-"}</span>;
                  if (col.id === "reason") return <span class="text-dimmed">{formatReason(entry.reason)}</span>;
                  if (col.id === "deleted") return <span class="text-dimmed">{dates.formatDateTime(entry.deletedAt, { locale })}</span>;
                  if (col.id === "details") {
                    return (
                      <DeletedAccountDetails
                        displayName={entry.displayName || entry.uid}
                        uid={entry.uid}
                        mail={entry.mail}
                        previousProvider={entry.previousProvider}
                        previousProfile={entry.previousProfile}
                        reason={formatReason(entry.reason)}
                        deletedAt={dates.formatDateTime(entry.deletedAt, { locale })}
                        metadata={entry.meta}
                      />
                    );
                  }
                  return "";
                }}
              />
            </Paper>
          )}

          <div class="pt-1">
            <Pagination currentPage={page} totalPages={totalPages} baseUrl={baseUrl} />
          </div>
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
