import { DataTable, type DataTableColumn, Pagination, Paper, Placeholder, Tag } from "@k2b/ui";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService, coreSettings } from "@k2b/cloud/services";
import { getDefaultGroupScope, isAdminUser } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { ssr } from "../../config";
import AccountsWorkspace from "../AccountsWorkspace";

import { buildGroupDetailUrl, buildGroupsPageBaseUrl, buildGroupsUrl, parseGroupsListState } from "../lib/url-state";
import { accountsMessages } from "../messages";
import GroupsScopeFilter from "./GroupsScopeFilter.island";
import NewGroup from "./NewGroup.island";

/** Groups page - nav sidebar + full-page list. */
export default ssr<AuthContext>(async (c) => {
  const { t } = accountsMessages.resolve([getLocale(c)]);
  const sessionUser = expectUserBackedActor(c);
  const isAdmin = isAdminUser(sessionUser);
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const perPage = 100;
  const defaultScope = getDefaultGroupScope(sessionUser);
  const listState = parseGroupsListState(
    {
      search: c.req.query("search"),
      page: c.req.query("page"),
      provider: c.req.query("provider"),
      scope: c.req.query("scope"),
    },
    { defaultScope },
  );
  const groupsPage = await accountsService.group.list({
    pagination: { page: listState.page, perPage },
    filter: { search: listState.search || undefined },
    scope: {
      userId: listState.scope === "all" ? undefined : sessionUser.id,
      mode: listState.scope,
      provider: listState.provider || undefined,
    },
  });
  const pendingRequestsPage = isAdmin
    ? await accountsService.accountRequest.list({
        access: { userId: sessionUser.id, isAdmin: true },
        filter: { status: "pending" },
      })
    : { total: 0 };
  const totalPages = Math.max(1, Math.ceil(groupsPage.total / perPage));
  const paginationBaseUrl = buildGroupsPageBaseUrl(
    { search: listState.search, provider: listState.provider, scope: listState.scope },
    { defaultScope },
  );
  type GroupRow = (typeof groupsPage.items)[number];
  const columns: DataTableColumn<GroupRow>[] = [
    { id: "group", header: t.group, value: (group) => group.name },
    { id: "description", header: t.description, value: (group) => group.description, cellClass: "max-w-[22rem]" },
    { id: "managedBy", header: t.managedBy, value: (group) => (group.provider === "ipa" ? "FreeIPA" : t.local) },
    { id: "flags", header: t.flags, value: (group) => group.gidnumber },
  ];

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.groups }]}>
      <AccountsWorkspace active="groups" isAdmin={isAdmin} pendingRequests={pendingRequestsPage.total} scrollPreserveKey="accounts-groups">
        <div class="flex flex-col gap-2">
          <div class="min-w-0" style="view-transition-name: accounts-groups-title">
            <h1 class="text-base font-semibold text-primary">{t.groups}</h1>
            <p class="mt-1 text-xs text-dimmed">
              {listState.search ? t.resultCount({ count: groupsPage.total }) : t.groupCount({ count: groupsPage.total })}
            </p>
          </div>

          <div style="view-transition-name: accounts-groups-search">
            <SearchBar action={buildGroupsUrl({ ...listState, page: 1 }, { defaultScope })} value={listState.search} />
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <GroupsScopeFilter state={listState} defaultScope={defaultScope} />
            {isAdmin ? (
              <div class="ml-auto shrink-0">
                <NewGroup freeIpaEnabled={freeIpaEnabled} />
              </div>
            ) : null}
          </div>

          {groupsPage.items.length === 0 ? (
            <Placeholder
              surface="paper"
              description={
                <>
                  {listState.scope === "managed" && !listState.search
                    ? t.groupsEmptyManaged
                    : listState.search
                      ? t.groupsEmptySearch
                      : t.groupsEmptyView}
                </>
              }
            />
          ) : (
            <Paper class="overflow-hidden" style="view-transition-name: accounts-groups-table">
              <DataTable
                rows={groupsPage.items}
                columns={columns}
                getRowId={(group) => group.id}
                hoverRows
                class="overflow-x-auto"
                scrollPreserveKey="accounts-groups-table"
                renderCell={({ row: group, col }) => {
                  const isManaged = sessionUser.managesGroupIds.includes(group.id);
                  const href = buildGroupDetailUrl(group.id, listState, { defaultScope });
                  if (col.id === "group") {
                    return (
                      <a href={href} class="group flex items-center gap-2 truncate font-medium text-primary">
                        <i class={`ti shrink-0 text-sm ${isManaged ? "ti-user-edit app-accent-text" : "ti-users-group text-dimmed"}`} />
                        <span class="truncate transition-colors group-hover:app-accent-text">{group.name}</span>
                      </a>
                    );
                  }
                  if (col.id === "description") {
                    return (
                      <a href={href} class="block truncate text-dimmed" title={group.description || t.noDescription} tabindex={-1}>
                        {group.description || <span class="italic">{t.noDescription}</span>}
                      </a>
                    );
                  }
                  if (col.id === "managedBy") {
                    return (
                      <a href={href} class="block" tabindex={-1}>
                        <Tag>{group.provider === "ipa" ? "FreeIPA" : t.local}</Tag>
                      </a>
                    );
                  }
                  if (col.id === "flags") {
                    return (
                      <a href={href} class="block" tabindex={-1}>
                        <div class="flex flex-wrap gap-1">
                          {isManaged ? <Tag>{t.managed}</Tag> : null}
                          {group.gidnumber ? <Tag>POSIX</Tag> : null}
                          {!isManaged && !group.gidnumber ? <span class="text-dimmed">-</span> : null}
                        </div>
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
