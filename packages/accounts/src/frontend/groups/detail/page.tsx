import { ButtonLink } from "@k2b/ui";
import { z } from "zod";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { accountsAppService as accountsService, coreSettings } from "@valentinkolb/cloud/services";
import { canManageGroup, getDefaultGroupScope, isAdminUser } from "@valentinkolb/cloud/shared";
import { Layout } from "@valentinkolb/cloud/ssr";
import type { JSX } from "solid-js/jsx-runtime";
import { createPagination } from "@/contracts";
import { ssr } from "../../../config";
import { toAccountsActor } from "../../../shared/actor";
import AccountsFactGrid from "../../AccountsFactGrid";
import AccountsWorkspace from "../../AccountsWorkspace";
import { getProviderBadge } from "../../lib/account-badges";
import { buildGroupsUrl, GROUPS_CONTEXT_QUERY_KEYS, parseGroupsListState } from "../../lib/url-state";
import { accountsMessages } from "../../messages";
import GroupActions from "./GroupActions.island";
import {
  buildGroupDetailPageBaseUrl,
  createGroupDetailHrefBuilder,
  GROUP_DETAIL_TAB_META,
  getVisibleGroupDetailTabs,
  parseGroupDetailTab,
} from "./group-detail-url";
import ManagersTab from "./ManagersTab";
import MemberOfTab from "./MemberOfTab";
import MembersTab from "./MembersTab";

export default ssr<AuthContext>(async (c) => {
  const { t } = accountsMessages.resolve([getLocale(c)]);
  const groupId = c.req.param("id");
  const user = expectUserBackedActor(c);
  const accountsActor = toAccountsActor(user);
  const isAdmin = isAdminUser(user);
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const defaultScope = getDefaultGroupScope(user);

  const listState = parseGroupsListState(
    {
      search: c.req.query("list_search"),
      page: c.req.query("list_page"),
      provider: c.req.query("list_provider"),
      scope: c.req.query("list_scope"),
    },
    { keys: GROUPS_CONTEXT_QUERY_KEYS, defaultScope },
  );

  const groupsListHref = buildGroupsUrl(listState, {
    defaultScope,
  });
  const groupsBackLabel = listState.scope === "managed" ? t.managedGroups : listState.scope === "member" ? t.myGroups : t.allGroups;
  const renderGroupNotFound = () => ssr.error(c, 404, { action: { label: t.backToGroups, href: groupsListHref } });

  if (!groupId || !z.uuid().safeParse(groupId).success) {
    return renderGroupNotFound();
  }

  const group = await accountsService.group.get({ id: groupId });

  if (!group) {
    return renderGroupNotFound();
  }

  const canManage = canManageGroup(user, groupId);
  const providerBadge = group ? getProviderBadge(group.provider) : null;
  const tab = parseGroupDetailTab(c.req.query("tab"), isAdmin);
  const canMutateGroup = group.provider === "local" || freeIpaEnabled;
  const canManageMutations = canManage && canMutateGroup;

  const rawPage = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const perPage = 100;
  const search = c.req.query("search") ?? "";
  const indirect = c.req.query("indirect") === "true";
  const showServiceAccounts = c.req.query("service_accounts") === "true";

  const buildDetailHref = createGroupDetailHrefBuilder({ listState, defaultScope });

  const membersPageBaseUrl = buildGroupDetailPageBaseUrl(buildDetailHref, groupId, {
    tab: "members",
    search: search || null,
    indirect: indirect ? "true" : null,
    service_accounts: showServiceAccounts ? "true" : null,
  });
  const managersPageBaseUrl = buildGroupDetailPageBaseUrl(buildDetailHref, groupId, {
    tab: "managers",
    search: search || null,
    service_accounts: showServiceAccounts ? "true" : null,
  });
  const memberOfPageBaseUrl = buildGroupDetailPageBaseUrl(buildDetailHref, groupId, {
    tab: "member-of",
    search: search || null,
  });
  const toggleIndirectUrl = buildDetailHref(groupId, {
    tab: "members",
    search: search || null,
    indirect: indirect ? null : "true",
    service_accounts: showServiceAccounts ? "true" : null,
    page: null,
  });
  const toggleServiceAccountsUrl = buildDetailHref(groupId, {
    tab,
    search: search || null,
    indirect: tab === "members" && indirect ? "true" : null,
    service_accounts: showServiceAccounts ? null : "true",
    page: null,
  });

  const [pendingRequestsPage, parentGroupIdsPage, managedGroupIdsPage] = await Promise.all([
    isAdmin
      ? accountsService.accountRequest.list({
          access: { userId: user.id, isAdmin: true },
          filter: { status: "pending" },
        })
      : Promise.resolve({ total: 0 }),
    accountsService.group.parent.list({ id: groupId }),
    accountsService.group.managedGroup.list({ id: groupId }),
  ]);

  const parentGroupIds = parentGroupIdsPage.items;
  const managedGroupIds = managedGroupIdsPage.items;

  let memberItems = [] as Awaited<ReturnType<typeof accountsService.entity.list>>["items"];
  let managerItems = [] as Awaited<ReturnType<typeof accountsService.entity.list>>["items"];
  let parentItems = [] as Awaited<ReturnType<typeof accountsService.entity.list>>["items"];
  let directMemberUserIds: string[] = [];
  let directMemberGroupIds: string[] = [];
  let directManagerUserIds: string[] = [];
  let directManagerGroupIds: string[] = [];
  let membersPagination = createPagination({ page, perPage, offset: (page - 1) * perPage }, 0);
  let managersPagination = createPagination({ page, perPage, offset: (page - 1) * perPage }, 0);
  let memberOfPagination = createPagination({ page, perPage, offset: (page - 1) * perPage }, 0);

  if (tab === "members") {
    const [membersPage, directMembersPage] = await Promise.all([
      accountsService.entity.list({
        actor: accountsActor,
        pagination: { page, perPage },
        search: search || undefined,
        memberOfGroupId: groupId,
        recursive: indirect,
        kinds: showServiceAccounts ? ["user", "group", "service_account"] : ["user", "group"],
      }),
      accountsService.group.member.list({
        id: groupId,
        recursive: false,
      }),
    ]);

    memberItems = membersPage.items;
    directMemberUserIds = directMembersPage.items.filter((member) => member.type === "user").map((member) => member.id);
    directMemberGroupIds = directMembersPage.items.filter((member) => member.type === "group").map((member) => member.id);
    membersPagination = createPagination({ page, perPage, offset: (page - 1) * perPage }, membersPage.total);
  } else if (tab === "managers") {
    const [managersPage, directManagersPage] = await Promise.all([
      accountsService.entity.list({
        actor: accountsActor,
        pagination: { page, perPage },
        search: search || undefined,
        managerOfGroupId: groupId,
        kinds: showServiceAccounts ? ["user", "group", "service_account"] : ["user", "group"],
      }),
      accountsService.group.manager.list({
        id: groupId,
      }),
    ]);

    managerItems = managersPage.items;
    directManagerUserIds = directManagersPage.items.filter((manager) => manager.type === "user").map((manager) => manager.id);
    directManagerGroupIds = directManagersPage.items.filter((manager) => manager.type === "group").map((manager) => manager.id);
    managersPagination = createPagination({ page, perPage, offset: (page - 1) * perPage }, managersPage.total);
  } else if (tab === "member-of") {
    const parentGroupsPage = await accountsService.entity.list({
      actor: accountsActor,
      pagination: { page, perPage },
      search: search || undefined,
      parentGroupId: groupId,
      kinds: ["group"],
    });

    parentItems = parentGroupsPage.items;
    memberOfPagination = createPagination({ page, perPage, offset: (page - 1) * perPage }, parentGroupsPage.total);
  }

  const facts: Array<{ label: string; value: JSX.Element }> = [
    {
      label: t.provider,
      value: <span>{group.provider === "ipa" ? "FreeIPA" : t.local}</span>,
    },
    {
      label: t.description,
      value: group.description ? <span>{group.description}</span> : <span class="italic text-dimmed">{t.noDescription}</span>,
    },
    {
      label: t.groupType,
      value: <span>{group.gidnumber ? t.posixGroup : t.standardGroup}</span>,
    },
    {
      label: t.gid,
      value: group.gidnumber ? <span class="font-mono">{group.gidnumber}</span> : <span class="italic text-dimmed">{t.notSet}</span>,
    },
    {
      label: t.parentGroups,
      value: <span>{parentGroupIds.length}</span>,
    },
    {
      label: t.managedGroups,
      value: <span>{managedGroupIds.length}</span>,
    },
    {
      label: t.access,
      value: <span>{canManage ? t.canManageMembers : t.readOnly}</span>,
    },
    {
      label: t.mutations,
      value: <span>{canMutateGroup ? t.available : t.unavailableWithoutIpa}</span>,
    },
  ];

  const activeCountText =
    tab === "members"
      ? t.memberCount({ count: membersPagination.total, matching: Boolean(search) })
      : tab === "managers"
        ? t.managerCount({ count: managersPagination.total, matching: Boolean(search) })
        : t.parentGroupCount({ count: memberOfPagination.total, matching: Boolean(search) });

  return () => (
    <Layout
      c={c}
      fullWidth
      title={[
        { title: t.start, href: "/" },
        { title: t.accounts, href: "/app/accounts" },
        { title: t.groups, href: "/app/accounts/groups" },
        { title: group.name },
      ]}
    >
      <AccountsWorkspace
        active="groups"
        isAdmin={isAdmin}
        pendingRequests={pendingRequestsPage.total}
        scrollPreserveKey="accounts-group-detail"
      >
        <div class="flex flex-col gap-3">
          <div>
            <ButtonLink href={groupsListHref} size="sm" variant="secondary">
              <i class="ti ti-arrow-left" />
              {groupsBackLabel}
            </ButtonLink>
          </div>

          <div class="flex flex-wrap items-start justify-between gap-3 py-2" style="view-transition-name: accounts-group-title">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <h1 class="text-xl font-semibold tracking-tight text-primary">{group.name}</h1>
                {providerBadge && (
                  <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${providerBadge.className}`}>
                    {group.provider === "ipa" ? "FreeIPA" : t.local}
                  </span>
                )}
                {group.gidnumber && (
                  <span class="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                    POSIX
                  </span>
                )}
              </div>
              <p class="mt-1 truncate text-xs text-dimmed">
                {group.description || t.noDescription}
                {group.gidnumber ? ` · GID ${group.gidnumber}` : ""}
              </p>
            </div>
            {isAdmin && canMutateGroup && (
              <GroupActions
                id={group.id}
                name={group.name}
                provider={group.provider}
                isPosix={!!group.gidnumber}
                description={group.description}
                listHref={groupsListHref}
              />
            )}
          </div>

          <AccountsFactGrid facts={facts} columns={4} viewTransitionName="accounts-group-facts" />

          {canManageMutations && !isAdmin && <p class="text-xs text-dimmed">{t.canManageHere}</p>}
          {!canMutateGroup && <p class="text-xs text-amber-700 dark:text-amber-300">{t.ipaDisabledMutations}</p>}

          <div class="flex flex-wrap items-start justify-between gap-2" style="view-transition-name: accounts-group-tabs">
            <nav class="flex flex-wrap items-center gap-1" aria-label={t.groupDetailSections}>
              {getVisibleGroupDetailTabs(isAdmin).map((entryTab) => (
                <ButtonLink
                  href={buildDetailHref(groupId, {
                    tab: entryTab,
                    search: null,
                    page: null,
                    indirect: null,
                    service_accounts: null,
                  })}
                  size="sm"
                  variant={tab === entryTab ? "primary" : "subtle"}
                  role="tab"
                  aria-selected={tab === entryTab}
                >
                  <i class={`${GROUP_DETAIL_TAB_META[entryTab].icon} text-sm`} />
                  <span>{entryTab === "members" ? t.members : entryTab === "managers" ? t.managers : t.memberOf}</span>
                </ButtonLink>
              ))}
            </nav>
            <p class="px-1 py-2 text-xs text-dimmed">{activeCountText}</p>
          </div>

          {tab === "members" && (
            <MembersTab
              items={memberItems}
              pagination={membersPagination}
              search={search}
              groupId={groupId}
              groupProvider={group.provider}
              allMemberIds={directMemberUserIds}
              allMemberGroupIds={directMemberGroupIds}
              isAdmin={isAdmin}
              canManage={canManageMutations}
              indirect={indirect}
              groupHref={(targetGroupId) => buildDetailHref(targetGroupId)}
              pageBaseUrl={membersPageBaseUrl}
              toggleIndirectUrl={toggleIndirectUrl}
              serviceAccountsToggleUrl={toggleServiceAccountsUrl}
              showServiceAccounts={showServiceAccounts}
            />
          )}

          {tab === "managers" && (
            <ManagersTab
              items={managerItems}
              pagination={managersPagination}
              groupId={groupId}
              groupProvider={group.provider}
              allManagerIds={directManagerUserIds}
              allManagerGroupIds={directManagerGroupIds}
              canManage={canManageMutations}
              isAdmin={isAdmin}
              groupHref={(targetGroupId) => buildDetailHref(targetGroupId)}
              pageBaseUrl={managersPageBaseUrl}
              serviceAccountsToggleUrl={toggleServiceAccountsUrl}
              showServiceAccounts={showServiceAccounts}
            />
          )}

          {tab === "member-of" && (
            <MemberOfTab
              groupId={groupId}
              groupProvider={group.provider}
              items={parentItems}
              allParentGroupIds={parentGroupIds}
              isAdmin={isAdmin && canMutateGroup}
              groupHref={(targetGroupId) => buildDetailHref(targetGroupId)}
              pagination={memberOfPagination}
              pageBaseUrl={memberOfPageBaseUrl}
            />
          )}
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
