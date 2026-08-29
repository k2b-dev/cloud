import { dates } from "@k2b/stdlib";
import { ButtonLink, DataTable, type DataTableColumn, Placeholder } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import {
  accountsAppService as accountsService,
  coreSettings,
  type ServiceAccountCredentialOverview,
  serviceAccountCredentials,
} from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import type { JSX } from "solid-js/jsx-runtime";
import type { BaseGroup } from "@/contracts";
import AccountAvatar from "@/frontend/AccountAvatar";
import { ssr } from "../../../config";
import AccountsFactGrid from "../../AccountsFactGrid";
import AccountsWorkspace from "../../AccountsWorkspace";
import RemoveMember from "../../groups/detail/RemoveMember.island";
import { getManagementBadge, getPrimaryAccountBadge, getSupplementalRoleColor, getSupplementalRoles } from "../../lib/account-badges";
import { buildUserDetailUrl, buildUsersUrl, parseUsersListState } from "../../lib/url-state";
import { accountsMessages } from "../../messages";
import ServiceAccountCredentialActions from "../../service-accounts/ServiceAccountCredentialActions.island";
import AddToGroup from "./AddToGroup.island";
import UserActions from "./UserActions.island";

const formatAddress = (a: {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  state: string | null;
}): string | null => {
  const parts: string[] = [];
  if (a.street) parts.push(a.street);
  if (a.postalCode && a.city) parts.push(`${a.postalCode} ${a.city}`);
  else if (a.city) parts.push(a.city);
  else if (a.postalCode) parts.push(a.postalCode);
  if (a.state) parts.push(a.state);
  return parts.length > 0 ? parts.join(", ") : null;
};

export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const formatNullableDate = (value: string | null) => (value ? dates.formatDateTime(value, { locale }) : "-");
  const id = c.req.param("id")!;
  const recursive = c.req.query("recursive") === "true";
  const sessionUser = expectUserBackedActor(c);
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));

  const listState = parseUsersListState({
    search: c.req.query("search"),
    page: c.req.query("page"),
    provider: c.req.query("provider"),
    profile: c.req.query("profile"),
  });

  const user = await accountsService.user.get({ id });

  if (!user) {
    return () => (
      <Layout
        c={c}
        fullWidth
        title={[
          { title: t.start, href: "/" },
          { title: t.accounts, href: "/app/accounts" },
          { title: t.users, href: "/app/accounts/users" },
          { title: t.notFound },
        ]}
      >
        <div class="flex-1 flex items-center justify-center">
          <div class="text-center text-dimmed flex flex-col items-center gap-2">
            <i class="ti ti-user-off text-4xl" />
            <p class="text-sm">{t.userNotFound}</p>
            <a href={buildUsersUrl(listState)} class="text-xs hover:text-primary">
              {t.backToUsers}
            </a>
          </div>
        </div>
      </Layout>
    );
  }

  const isIpaUser = user.provider === "ipa";
  const isGuestProfile = user.profile === "guest";

  const [pendingRequestsPage, recursiveGroupsPage, managedGroupsPage, directGroupIds, apiKeysPage] = await Promise.all([
    accountsService.accountRequest.list({
      access: { userId: sessionUser.id, isAdmin: true },
      filter: { status: "pending" },
    }),
    accountsService.group.list({
      pagination: { page: 1, perPage: 1000 },
      scope: { userId: id, mode: "member" },
    }),
    accountsService.group.list({
      pagination: { page: 1, perPage: 1000 },
      scope: { userId: id, mode: "managed" },
    }),
    accountsService.user.groupId.list({
      userId: id,
      recursive: false,
    }),
    serviceAccountCredentials.listOverview({
      pagination: { page: 1, perPage: 100 },
      filter: { userId: id, serviceAccountKind: "user_delegated", credentialStatus: "active" },
    }),
  ]);

  const directGroupsPage = await (directGroupIds.length > 0
    ? accountsService.group.list({
        pagination: { page: 1, perPage: 1000 },
        scope: { ids: directGroupIds },
      })
    : {
        items: [] as BaseGroup[],
        page: 1,
        perPage: 0,
        total: 0,
        hasNext: false,
      });

  const allGroups = recursiveGroupsPage.items;
  const directGroups = directGroupsPage.items;
  const directGroupSet = new Set(directGroups.map((group) => group.id));
  const memberGroups = recursive ? allGroups : directGroups;
  const managedGroups = managedGroupsPage.items;

  const isExpired = user.accountExpires ? new Date(user.accountExpires) < new Date() : false;
  const managementBadge = getManagementBadge(user);

  const displayTitle = user.displayName || user.mail || user.uid;
  const primaryBadge = getPrimaryAccountBadge(user);
  const supplementalRoles = getSupplementalRoles(user);
  const ipa = user.provider === "ipa" ? user.ipa : null;
  const totalMemberGroups = recursive ? allGroups.length : directGroups.length;

  const facts: Array<{ label: string; value: JSX.Element }> = [
    { label: "UID", value: <span class="font-mono">{user.uid}</span> },
    { label: t.databaseId, value: <span class="truncate font-mono text-[11px]">{user.id}</span> },
    { label: t.managedBy, value: <span>{user.provider === "ipa" ? "FreeIPA" : t.local}</span> },
    { label: t.access, value: <span>{user.profile === "user" ? t.fullAccount : t.guestAccount}</span> },
    {
      label: t.email,
      value: user.mail ? <span class="truncate">{user.mail}</span> : <span class="italic text-dimmed">{t.notSet}</span>,
    },
    {
      label: isIpaUser ? t.passwordExpires : t.accountExpires,
      value: isIpaUser ? (
        ipa?.passwordExpires ? (
          <span>{dates.formatDate(ipa.passwordExpires, { locale })}</span>
        ) : (
          <span class="italic text-dimmed">{t.never}</span>
        )
      ) : user.accountExpires ? (
        <span class={isExpired ? "text-red-600 dark:text-red-400" : ""}>
          {dates.formatDate(user.accountExpires, { locale })}
          {isExpired ? t.expiredSuffix : ""}
        </span>
      ) : (
        <span class="italic text-dimmed">{t.never}</span>
      ),
    },
    {
      label: isIpaUser ? t.accountExpires : isGuestProfile ? t.guestExpires : t.lastWebLogin,
      value: isIpaUser ? (
        user.accountExpires ? (
          <span class={isExpired ? "text-red-600 dark:text-red-400" : ""}>
            {dates.formatDate(user.accountExpires, { locale })}
            {isExpired ? t.expiredSuffix : ""}
          </span>
        ) : (
          <span class="italic text-dimmed">{t.never}</span>
        )
      ) : user.lastLoginLocal ? (
        <span>{dates.formatDate(user.lastLoginLocal, { locale })}</span>
      ) : (
        <span class="italic text-dimmed">{t.never}</span>
      ),
    },
    {
      label: isIpaUser ? t.lastKerberosLogin : t.directGroups,
      value: isIpaUser ? (
        ipa?.lastLoginIpa ? (
          <span>{dates.formatDate(ipa.lastLoginIpa, { locale })}</span>
        ) : (
          <span class="italic text-dimmed">{t.neverTracked}</span>
        )
      ) : (
        <span>{directGroups.length}</span>
      ),
    },
    {
      label: isIpaUser ? t.lastWebLogin : t.managedGroups,
      value: isIpaUser ? (
        user.lastLoginLocal ? (
          <span>{dates.formatDate(user.lastLoginLocal, { locale })}</span>
        ) : (
          <span class="italic text-dimmed">{t.never}</span>
        )
      ) : (
        <span>{managedGroups.length}</span>
      ),
    },
    { label: t.apiKeys, value: <span>{apiKeysPage.total}</span> },
  ];

  if (isIpaUser && ipa?.employeeType) {
    facts.push({ label: t.role, value: <span>{ipa.employeeType}</span> });
  }
  if (isIpaUser && ipa?.mobile && ipa.mobile !== ipa.phone) {
    facts.push({ label: t.mobile, value: <span>{ipa.mobile}</span> });
  }
  if (isIpaUser && ipa?.address && formatAddress(ipa.address)) {
    facts.push({ label: t.address, value: <span>{formatAddress(ipa.address)}</span> });
  }

  const detailHref = buildUserDetailUrl(id, listState);
  const toggleUrl = recursive ? detailHref : `${detailHref}${detailHref.includes("?") ? "&" : "?"}recursive=true`;
  const memberGroupColumns: DataTableColumn<BaseGroup>[] = [
    { id: "group", header: t.group, value: (group) => group.name },
    { id: "description", header: t.description, value: (group) => group.description, cellClass: "max-w-[24rem]" },
    { id: "provider", header: t.provider, value: (group) => group.provider },
    { id: "membership", header: t.membership, value: (group) => (directGroupSet.has(group.id) ? t.direct : t.inherited) },
    { id: "actions", header: t.actions, headerClass: "text-right", cellClass: "text-right whitespace-nowrap max-w-none" },
  ];
  const managedGroupColumns: DataTableColumn<BaseGroup>[] = [
    { id: "group", header: t.group, value: (group) => group.name },
    { id: "description", header: t.description, value: (group) => group.description, cellClass: "max-w-[24rem]" },
    { id: "provider", header: t.provider, value: (group) => group.provider },
  ];
  const apiKeyColumns: DataTableColumn<ServiceAccountCredentialOverview>[] = [
    { id: "key", header: t.apiKey, value: (key) => key.name, cellClass: "min-w-[14rem]" },
    { id: "expires", header: t.expires, value: (key) => key.expiresAt, cellClass: "whitespace-nowrap" },
    { id: "lastUsed", header: t.lastUsed, value: (key) => key.lastUsedAt, cellClass: "whitespace-nowrap" },
    { id: "created", header: t.created, value: (key) => key.createdAt, cellClass: "whitespace-nowrap" },
    { id: "actions", header: t.actions, headerClass: "text-right", cellClass: "text-right whitespace-nowrap max-w-none" },
  ];

  return () => (
    <Layout
      c={c}
      fullWidth
      title={[
        { title: t.start, href: "/" },
        { title: t.accounts, href: "/app/accounts" },
        { title: t.users, href: "/app/accounts/users" },
        { title: user.uid },
      ]}
    >
      <AccountsWorkspace active="users" isAdmin={true} pendingRequests={pendingRequestsPage.total} scrollPreserveKey="accounts-user-detail">
        <div class="flex flex-col gap-3">
          <div>
            <ButtonLink href={buildUsersUrl(listState)} size="sm" variant="secondary">
              <i class="ti ti-arrow-left" />
              Back to Users
            </ButtonLink>
          </div>

          <div class="flex flex-wrap items-start justify-between gap-3 py-2" style="view-transition-name: accounts-user-title">
            <div class="flex min-w-0 flex-1 items-start gap-3">
              <AccountAvatar name={displayTitle} userId={user.id} avatarHash={user.avatarHash} size="md" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <h1 class="text-xl font-semibold tracking-tight text-primary">{displayTitle}</h1>
                  <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${primaryBadge.className}`}>
                    {user.profile === "user" ? t.fullAccount : t.guestAccount}
                  </span>
                  <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${managementBadge.className}`}>
                    {user.provider === "ipa" ? "FreeIPA" : t.local}
                  </span>
                  {supplementalRoles.map((role) => (
                    <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${getSupplementalRoleColor(role)}`}>
                      {role === "group-manager" ? t.groupManager : t.admin}
                    </span>
                  ))}
                  {isExpired && (
                    <span class="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-900/50 dark:text-red-300">
                      {t.expired}
                    </span>
                  )}
                </div>
                <p class="mt-1 truncate text-xs text-dimmed">
                  {user.uid}
                  {user.mail ? ` · ${user.mail}` : ""}
                  {user.givenname || user.sn ? ` · ${[user.givenname, user.sn].filter(Boolean).join(" ")}` : ""}
                </p>
              </div>
            </div>
            <div class="flex flex-wrap items-center justify-end gap-2">
              <UserActions user={user} listHref={buildUsersUrl(listState)} freeIpaEnabled={freeIpaEnabled} />
            </div>
          </div>

          <AccountsFactGrid facts={facts} columns={3} viewTransitionName="accounts-user-facts" />

          {isIpaUser && (ipa?.sshFingerprints.length ?? 0) > 0 && (
            <div class="rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-muted)]" style="view-transition-name: accounts-user-ssh">
              <details class="group">
                <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs text-dimmed">
                  <span class="flex items-center gap-2">
                    <i class="ti ti-key text-sm" />
                    {t.sshKeyCount({ count: ipa?.sshPublicKeys.length ?? 0 })}
                  </span>
                  <i class="ti ti-chevron-right text-xs transition-transform group-open:rotate-90" />
                </summary>
                <div class="px-3 pb-3">
                  <div class="flex flex-col gap-1">
                    {ipa?.sshFingerprints.map((fp) => (
                      <code class="rounded bg-zinc-100 px-2 py-1 text-[11px] font-mono text-secondary dark:bg-zinc-800">{fp}</code>
                    ))}
                  </div>
                </div>
              </details>
            </div>
          )}

          <div class="flex flex-col gap-2" style="view-transition-name: accounts-user-api-keys">
            <div class="flex flex-wrap items-end justify-between gap-2">
              <div class="min-w-0">
                <h2 class="text-base font-semibold text-primary">{t.apiKeys}</h2>
                <p class="mt-1 text-xs text-dimmed">{t.personalAutomationKeys({ count: apiKeysPage.total })}</p>
              </div>
              <ButtonLink
                href={`/app/accounts/service-accounts?kind=user_delegated&status=active&search=${encodeURIComponent(user.uid)}`}
                size="sm"
                variant="subtle"
              >
                <i class="ti ti-external-link" />
                {t.viewAll}
              </ButtonLink>
            </div>

            {apiKeysPage.items.length > 0 ? (
              <div class="paper overflow-hidden">
                <DataTable
                  rows={apiKeysPage.items}
                  columns={apiKeyColumns}
                  getRowId={(key) => key.id}
                  hoverRows
                  highlightColumns={false}
                  class="overflow-x-auto"
                  scrollPreserveKey="accounts-user-api-keys"
                  renderCell={({ row: key, col }) => {
                    if (col.id === "key")
                      return (
                        <div class="flex min-w-0 flex-col gap-1">
                          <span class="truncate font-medium text-primary">{key.name}</span>
                          <span class="truncate font-mono text-[11px] text-dimmed">cld_{key.tokenPrefix}_...</span>
                        </div>
                      );
                    if (col.id === "expires") return <span class="text-dimmed">{formatNullableDate(key.expiresAt)}</span>;
                    if (col.id === "lastUsed") return <span class="text-dimmed">{formatNullableDate(key.lastUsedAt)}</span>;
                    if (col.id === "created") return <span class="text-dimmed">{dates.formatDateTime(key.createdAt, { locale })}</span>;
                    if (col.id === "actions") return <ServiceAccountCredentialActions credentialId={key.id} name={key.name} />;
                    return "";
                  }}
                />
              </div>
            ) : (
              <Placeholder surface="paper" description={<>{t.noActiveApiKeys}</>} />
            )}
          </div>

          <div class="flex flex-col gap-2" style="view-transition-name: accounts-user-memberships">
            <div class="flex flex-wrap items-end justify-between gap-2">
              <div class="min-w-0">
                <h2 class="text-base font-semibold text-primary">{t.groups}</h2>
                <p class="mt-1 text-xs text-dimmed">
                  {recursive
                    ? t.membershipsIncludingInherited({ count: totalMemberGroups })
                    : t.directMemberships({ count: totalMemberGroups })}
                </p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <ButtonLink
                  href={toggleUrl}
                  size="sm"
                  variant={recursive ? "primary" : "subtle"}
                  aria-current={recursive ? "true" : undefined}
                  title={recursive ? t.showDirectOnly : t.showAllMemberships}
                >
                  <i class="ti ti-git-branch" />
                  {recursive ? t.allGroups : t.directOnly}
                </ButtonLink>
                <AddToGroup id={user.id} userProvider={user.provider} excludeGroups={allGroups.map((group) => group.id)} />
              </div>
            </div>

            {memberGroups.length > 0 ? (
              <div class="paper overflow-hidden">
                <DataTable
                  rows={memberGroups}
                  columns={memberGroupColumns}
                  getRowId={(group) => group.id}
                  hoverRows
                  class="overflow-x-auto"
                  scrollPreserveKey="accounts-user-member-groups"
                  renderCell={({ row: group, col }) => {
                    const href = `/app/accounts/groups/${group.id}`;
                    const isDirect = directGroupSet.has(group.id);
                    const providerBadge = getPrimaryAccountBadge({ ...user, provider: group.provider, profile: "user" });
                    if (col.id === "group")
                      return (
                        <a href={href} class="block truncate font-medium text-primary hover:underline">
                          {group.name}
                        </a>
                      );
                    if (col.id === "description") {
                      return (
                        <a href={href} class="block truncate text-dimmed" tabindex={-1} title={group.description || t.noDescription}>
                          {group.description || <span class="italic">{t.noDescription}</span>}
                        </a>
                      );
                    }
                    if (col.id === "provider")
                      return (
                        <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${providerBadge.className}`}>
                          {group.provider === "ipa" ? "FreeIPA" : t.local}
                        </span>
                      );
                    if (col.id === "membership") {
                      return (
                        <span
                          class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${isDirect ? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200" : "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"}`}
                        >
                          {isDirect ? t.direct : t.inherited}
                        </span>
                      );
                    }
                    if (col.id === "actions")
                      return isDirect ? (
                        <RemoveMember groupId={group.id} membershipRole="members" type="user" id={user.id} label={user.uid} />
                      ) : null;
                    return "";
                  }}
                />
              </div>
            ) : (
              <Placeholder surface="paper" description={<>{t.noGroupMemberships}</>} />
            )}
          </div>

          {managedGroups.length > 0 && (
            <div class="flex flex-col gap-2" style="view-transition-name: accounts-user-managed-groups">
              <div class="min-w-0">
                <h2 class="text-base font-semibold text-primary">{t.manages}</h2>
                <p class="mt-1 text-xs text-dimmed">{t.manageableGroups({ count: managedGroups.length })}</p>
              </div>

              <div class="paper overflow-hidden">
                <DataTable
                  rows={managedGroups}
                  columns={managedGroupColumns}
                  getRowId={(group) => group.id}
                  hoverRows
                  class="overflow-x-auto"
                  scrollPreserveKey="accounts-user-managed-groups"
                  renderCell={({ row: group, col }) => {
                    const href = `/app/accounts/groups/${group.id}`;
                    if (col.id === "group")
                      return (
                        <a href={href} class="block truncate font-medium text-primary hover:underline">
                          {group.name}
                        </a>
                      );
                    if (col.id === "description") {
                      return (
                        <a href={href} class="block truncate text-dimmed" tabindex={-1} title={group.description || t.noDescription}>
                          {group.description || <span class="italic">{t.noDescription}</span>}
                        </a>
                      );
                    }
                    if (col.id === "provider") {
                      return (
                        <span
                          class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${group.provider === "ipa" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"}`}
                        >
                          {group.provider === "ipa" ? "FreeIPA" : t.local}
                        </span>
                      );
                    }
                    return "";
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
