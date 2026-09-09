import { ButtonLink, DataTable, type DataTableColumn, Pagination, Paper, Placeholder, Tag } from "@k2b/ui";
import { accountCategoryLabel } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService, coreSettings, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import AccountAvatar from "@/frontend/AccountAvatar";
import { ssr } from "../../config";
import AccountsWorkspace from "../AccountsWorkspace";

import { buildUserDetailUrl, buildUsersPageBaseUrl, buildUsersUrl, parseUsersListState } from "../lib/url-state";
import { accountsMessages } from "../messages";
import CreateUserForm from "./new/CreateUserForm.island";
import UsersFilters from "./UsersFilters.island";

/** Admin users list page - nav sidebar + full-page list. */
export default ssr<AuthContext>(async (c) => {
  const { t } = accountsMessages.resolve([getLocale(c)]);
  const perPage = 100;
  const user = expectUserBackedActor(c);
  const categoryPolicy = await readAccountCategoryPolicy();
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const listState = parseUsersListState({
    search: c.req.query("search"),
    page: c.req.query("page"),
    provider: c.req.query("provider"),
    profile: c.req.query("profile"),
  });
  const [pendingRequestsPage, usersPage] = await Promise.all([
    accountsService.accountRequest.list({ access: { userId: user.id, isAdmin: true }, filter: { status: "pending" } }),
    accountsService.user.list({
      pagination: { page: listState.page, perPage },
      filter: { search: listState.search || undefined },
      scope: {
        provider: listState.provider || undefined,
        profile: listState.profile || undefined,
      },
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(usersPage.total / perPage));
  const paginationBaseUrl = buildUsersPageBaseUrl({
    search: listState.search,
    provider: listState.provider,
    profile: listState.profile,
  });
  type UserRow = (typeof usersPage.items)[number];
  const columns: DataTableColumn<UserRow>[] = [
    { id: "user", header: t.user, value: (entry) => entry.displayName || entry.mail || entry.uid },
    { id: "email", header: t.email, value: (entry) => entry.mail, cellClass: "max-w-[18rem]" },
    { id: "category", header: t.accountType, value: (entry) => accountCategoryLabel(entry, categoryPolicy.login.label) },
  ];

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.users }]}>
      <AccountsWorkspace active="users" isAdmin={true} pendingRequests={pendingRequestsPage.total} scrollPreserveKey="accounts-users">
        <div class="flex flex-col gap-2">
          <div class="min-w-0" style="view-transition-name: accounts-users-title">
            <h1 class="text-base font-semibold text-primary">{t.users}</h1>
            <p class="mt-1 text-xs text-dimmed">
              {listState.search ? t.resultCount({ count: usersPage.total }) : t.userCount({ count: usersPage.total })}
            </p>
          </div>

          <div style="view-transition-name: accounts-users-search">
            <SearchBar
              action={buildUsersUrl({
                ...listState,
                search: "",
                page: 1,
              })}
              value={listState.search}
            />
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <UsersFilters state={listState} />
            <ButtonLink href="/app/accounts/duplicate-emails" variant="subtle" size="sm">
              {t.duplicateEmails}
            </ButtonLink>
            <div class="ml-auto">
              <CreateUserForm buttonClass="shrink-0" freeIpaEnabled={freeIpaEnabled} categoryPolicy={categoryPolicy} />
            </div>
          </div>

          {usersPage.items.length === 0 ? (
            <Placeholder surface="paper" description={<>{t.usersEmpty}</>} />
          ) : (
            <Paper class="overflow-hidden" style="view-transition-name: accounts-users-table">
              <DataTable
                rows={usersPage.items}
                columns={columns}
                getRowId={(entry) => entry.id}
                hoverRows
                class="overflow-x-auto"
                scrollPreserveKey="accounts-users-table"
                renderCell={({ row: entry, col }) => {
                  const href = buildUserDetailUrl(entry.id, listState);
                  if (col.id === "user") {
                    return (
                      <a href={href} class="flex min-w-0 items-center gap-2 text-primary hover:underline">
                        <AccountAvatar
                          name={entry.displayName || entry.mail || entry.uid}
                          userId={entry.id}
                          avatarHash={entry.avatarHash}
                          size="xs"
                        />
                        <span class="block truncate font-medium">{(entry.displayName || entry.mail || entry.uid) + ` (${entry.uid})`}</span>
                      </a>
                    );
                  }
                  if (col.id === "email") {
                    return (
                      <a href={href} class="block truncate text-dimmed" title={entry.mail || "-"} tabindex={-1}>
                        {entry.mail || "-"}
                      </a>
                    );
                  }
                  if (col.id === "category") {
                    return (
                      <a href={href} class="block" tabindex={-1}>
                        <Tag>{accountCategoryLabel(entry, categoryPolicy.login.label)}</Tag>
                      </a>
                    );
                  }
                  return "";
                }}
              />
            </Paper>
          )}

          <div class="pt-1">
            <Pagination currentPage={listState.page} totalPages={totalPages} baseUrl={paginationBaseUrl} />
          </div>
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
