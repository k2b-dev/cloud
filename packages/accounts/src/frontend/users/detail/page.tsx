import { dates } from "@k2b/stdlib";
import { ButtonLink, CodeDisplay, DataTable, type DataTableColumn, Disclosure, Paper, Placeholder, StatusBadge, Tag } from "@k2b/ui";
import { accountCategory, accountCategoryLabel } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import {
  accountsAppService as accountsService,
  appApproval,
  coreSettings,
  linuxIdentities,
  readAccountCategoryPolicy,
  type ServiceAccountCredentialOverview,
  serviceAccountCredentials,
} from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import type { JSX } from "solid-js/jsx-runtime";
import { z } from "zod";
import type { BaseGroup } from "@/contracts";
import AccountAvatar from "@/frontend/AccountAvatar";
import { ssr } from "../../../config";
import AccountsFactGrid from "../../AccountsFactGrid";
import AccountsWorkspace from "../../AccountsWorkspace";
import RemoveMember from "../../groups/detail/RemoveMember.island";
import { getSupplementalRoles } from "../../lib/account-badges";
import { buildUserDetailUrl, buildUsersUrl, parseUsersListState } from "../../lib/url-state";
import { accountsMessages } from "../../messages";
import ServiceAccountCredentialActions from "../../service-accounts/ServiceAccountCredentialActions.island";
import AddToGroup from "./AddToGroup.island";
import LinuxIdentity from "./LinuxIdentity.island";
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
  if (!z.uuid().safeParse(id).success) return ssr.error(c, 404);
  const recursive = c.req.query("recursive") === "true";
  const sessionUser = expectUserBackedActor(c);
  const categoryPolicy = await readAccountCategoryPolicy();
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const approvalConfig = await appApproval.config().catch(() => null);

  const listState = parseUsersListState({
    search: c.req.query("search"),
    page: c.req.query("page"),
    provider: c.req.query("provider"),
    profile: c.req.query("profile"),
  });

  const user = await accountsService.user.get({ id });

  if (!user) return ssr.error(c, 404, { action: { label: t.backToUsers, href: buildUsersUrl(listState) } });
  const linux = await linuxIdentities.get(sessionUser, id);

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

  const displayTitle = user.displayName || user.mail || user.uid;

  const supplementalRoles = getSupplementalRoles(user);
  const ipa = user.provider === "ipa" ? user.ipa : null;
  const totalMemberGroups = recursive ? allGroups.length : directGroups.length;

  const facts: Array<{ label: string; value: JSX.Element }> = [
    { label: "UID", value: <span class="font-mono">{user.uid}</span> },
    { label: t.databaseId, value: <span class="truncate font-mono text-xs">{user.id}</span> },
    { label: t.accountType, value: <span>{accountCategoryLabel(user, categoryPolicy.login.label)}</span> },
    { label: t.access, value: <span>{user.profile === "user" ? t.fullAccount : t.guestAccount}</span> },
    {
      label: t.email,
      value: user.mail ? <span>{user.mail}</span> : <span class="italic text-dimmed">{t.notSet}</span>,
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
        <StatusBadge
          tone={isExpired ? "error" : "neutral"}
          variant="text"
          icon={null}
          label={
            <>
              {dates.formatDate(user.accountExpires, { locale })}
              {isExpired ? t.expiredSuffix : ""}
            </>
          }
        />
      ) : (
        <span class="italic text-dimmed">{t.never}</span>
      ),
    },
    {
      label: isIpaUser ? t.accountExpires : isGuestProfile ? t.guestExpires : t.lastWebLogin,
      value: isIpaUser ? (
        user.accountExpires ? (
          <StatusBadge
            tone={isExpired ? "error" : "neutral"}
            variant="text"
            icon={null}
            label={
              <>
                {dates.formatDate(user.accountExpires, { locale })}
                {isExpired ? t.expiredSuffix : ""}
              </>
            }
          />
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
                  <Tag>{accountCategoryLabel(user, categoryPolicy.login.label)}</Tag>
                  {supplementalRoles.map((role) => (
                    <Tag>{role === "group-manager" ? t.groupManager : t.admin}</Tag>
                  ))}
                  {isExpired && <StatusBadge tone="error" label={t.expired} />}
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
              {approvalConfig?.enabled && approvalConfig.adminPairing && !isExpired && categoryPolicy[accountCategory(user)].enabled && (
                <ButtonLink href={`/me/security/pair?userId=${user.id}`} variant="secondary" size="sm">
                  <i class="ti ti-device-mobile" />
                  {t.pairAppDevice}
                </ButtonLink>
              )}
            </div>
          </div>

          <AccountsFactGrid facts={facts} viewTransitionName="accounts-user-facts" />
          {(linux.user.identity || linux.user.provider === "ipa" || (linux.config.enabled && linux.user.profile === "user")) && (
            <LinuxIdentity initial={linux} />
          )}

          {isIpaUser && (ipa?.sshFingerprints.length ?? 0) > 0 && (
            <Paper style="view-transition-name: accounts-user-ssh">
              <Disclosure summary={t.sshKeyCount({ count: ipa?.sshPublicKeys.length ?? 0 })} icon="ti ti-key">
                <CodeDisplay code={ipa?.sshFingerprints.join("\n") ?? ""} lineNumbers={false} />
              </Disclosure>
            </Paper>
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
              <Paper class="overflow-hidden">
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
                          <span class="truncate font-mono text-xs text-dimmed">cld_{key.tokenPrefix}_...</span>
                        </div>
                      );
                    if (col.id === "expires") return <span class="text-dimmed">{formatNullableDate(key.expiresAt)}</span>;
                    if (col.id === "lastUsed") return <span class="text-dimmed">{formatNullableDate(key.lastUsedAt)}</span>;
                    if (col.id === "created") return <span class="text-dimmed">{dates.formatDateTime(key.createdAt, { locale })}</span>;
                    if (col.id === "actions") return <ServiceAccountCredentialActions credentialId={key.id} name={key.name} />;
                    return "";
                  }}
                />
              </Paper>
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
              <Paper class="overflow-hidden">
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
                    if (col.id === "provider") return <Tag>{group.provider === "ipa" ? "FreeIPA" : t.local}</Tag>;
                    if (col.id === "membership") {
                      return <Tag>{isDirect ? t.direct : t.inherited}</Tag>;
                    }
                    if (col.id === "actions")
                      return isDirect ? (
                        <RemoveMember groupId={group.id} membershipRole="members" type="user" id={user.id} label={user.uid} />
                      ) : null;
                    return "";
                  }}
                />
              </Paper>
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

              <Paper class="overflow-hidden">
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
                      return <Tag>{group.provider === "ipa" ? "FreeIPA" : t.local}</Tag>;
                    }
                    return "";
                  }}
                />
              </Paper>
            </div>
          )}
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
