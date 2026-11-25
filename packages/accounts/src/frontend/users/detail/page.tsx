import { cloudAvatarImage } from "@k2b/cloud/account/ui";
import { accountCategory, accountCategoryLabel, isModelsOnlyApiKey } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import {
  accountsAppService as accountsService,
  appApproval,
  coreSettings,
  linuxIdentities,
  pwaDevices,
  readAccountCategoryPolicy,
  serviceAccountCredentials,
  serviceAccounts,
} from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { z } from "zod";
import type { BaseGroup } from "@/contracts";
import { ssr } from "../../../config";
import AccountsNavigation from "../../AccountsNavigation.island";
import { accountsNavigationItems } from "../../accounts-nav";
import { isAgentRecordKind, renderAgentRecord } from "../../agents/agent-record";
import { getSupplementalRoles } from "../../lib/account-badges";
import { accountsMessages } from "../../messages";
import { usersListContext, usersListHref, usersQuery } from "../query";
import UserScreen from "./UserScreen.island";
import type { UserFact, UserGroupView, UserRecordView } from "./user-view";
import { userTabFrom } from "./user-view";

/** The most groups and keys one page lists: the services' page limits, as before. */
const GROUPS_PER_PAGE = 1000;
const KEYS_PER_PAGE = 100;

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

/**
 * The account record of every kind: a person here, an agent or standalone service account through the agent kind.
 * A person's record. The address names the list it came from (`?list=`), the open tab (`?tab=`) and whether the
 * memberships include inherited groups (`?recursive=true`), so reload, back and forward show the same page. Every
 * area loads here, on the server, so the first picture has no loading state.
 */
export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const id = c.req.param("id")!;
  if (!z.uuid().safeParse(id).success) return ssr.error(c, 404);
  const recursive = c.req.query("recursive") === "true";
  const tab = userTabFrom(c.req.query("tab"), recursive);
  const sessionUser = expectUserBackedActor(c);
  const admin = sessionUser.roles.includes("admin");
  // The list this page was opened from, so its links lead back to the same filtered list.
  const list = usersListContext(usersQuery(locale), new URL(c.req.url).searchParams);
  const listHref = usersListHref(list);

  const user = await accountsService.user.get({ id });
  if (!user) {
    // Not a person: the record opens the service accounts the agent page opened, through the same service; any other
    // kind (code, resource-bound, a person's own keys) and an unknown id stay the 404 of before.
    const account = await serviceAccounts.get({ id });
    // Kind slot: lane C's service-account sections (ApiKeysSection, DirectoryAccessSection) join the agent kind here.
    if (account && isAgentRecordKind(account)) return renderAgentRecord(c, account);
    return ssr.error(c, 404, { action: { label: t.backToUsers, href: listHref } });
  }
  const linux = await linuxIdentities.get(sessionUser, id);
  const [categoryPolicy, freeIpaEnabled, localEmailOptional, cloudName, approvalConfig] = await Promise.all([
    readAccountCategoryPolicy(),
    coreSettings.get<boolean>("freeipa.enable"),
    coreSettings.get<boolean>("user.local_email_optional"),
    coreSettings.get<string>("app.name"),
    appApproval.config().catch(() => null),
  ]);

  const [pendingRequests, recursiveGroupsPage, managedGroupsPage, directGroupIds, apiKeysPage, devices, phones] = await Promise.all([
    accountsService.accountRequest.countPending(),
    accountsService.group.list({ pagination: { page: 1, perPage: GROUPS_PER_PAGE }, scope: { userId: id, mode: "member" } }),
    accountsService.group.list({ pagination: { page: 1, perPage: GROUPS_PER_PAGE }, scope: { userId: id, mode: "managed" } }),
    accountsService.user.groupId.list({ userId: id, recursive: false }),
    serviceAccountCredentials.listOverview({
      pagination: { page: 1, perPage: KEYS_PER_PAGE },
      filter: { userId: id, serviceAccountKind: "user_delegated", credentialStatus: "active" },
    }),
    // Null shows "could not be loaded" instead of hiding a device an administrator may need to revoke.
    appApproval.listUserDevices({ userId: sessionUser.id, admin }, id).catch(() => null),
    pwaDevices.listUserDevices({ userId: sessionUser.id, admin }, id).catch(() => null),
  ]);
  const directGroupsPage =
    directGroupIds.length > 0
      ? await accountsService.group.list({ pagination: { page: 1, perPage: GROUPS_PER_PAGE }, scope: { ids: directGroupIds } })
      : { items: [] as BaseGroup[] };

  const directGroups = directGroupsPage.items.filter((group) => group.personalOwner === null);
  const direct = new Set(directGroups.map((group) => group.id));
  const allGroups = recursiveGroupsPage.items;
  const groupView = (group: BaseGroup): UserGroupView => ({
    id: group.id,
    name: group.name,
    description: group.description,
    provider: group.provider,
    direct: direct.has(group.id),
  });

  const now = new Date();
  const isExpired = user.accountExpires ? new Date(user.accountExpires) < now : false;
  const day = (value: string) => dates.formatDate(value, { locale });
  const moment = (value: string) => dates.formatDateTime(value, { locale });
  const title = user.displayName || user.mail || user.uid;
  const ipa = user.provider === "ipa" ? user.ipa : null;
  const category = accountCategory(user);
  const missing = (label: string, value: string | null | undefined, empty: string): UserFact =>
    value ? { label, value } : { label, value: empty, missing: true };
  const expiry: UserFact = user.accountExpires
    ? {
        label: user.profile === "guest" && !ipa ? t.guestExpires : t.accountExpires,
        value: `${day(user.accountExpires)}${isExpired ? t.expiredSuffix : ""}`,
        overdue: isExpired,
      }
    : { label: user.profile === "guest" && !ipa ? t.guestExpires : t.accountExpires, value: t.never, missing: true };
  const address = ipa ? formatAddress(ipa.address) : null;
  const facts: UserFact[] = [
    { label: "UID", value: user.uid, mono: true, copy: true },
    { label: t.databaseId, value: user.id, mono: true, copy: true },
    { label: t.accountType, value: accountCategoryLabel(user, categoryPolicy.login.label) },
    { label: t.access, value: user.profile === "user" ? t.fullAccount : t.guestAccount },
    user.mail ? { label: t.email, value: user.mail, copy: true } : { label: t.email, value: t.notSet, missing: true },
    ...(ipa ? [missing(t.passwordExpires, ipa.passwordExpires && day(ipa.passwordExpires), t.never)] : []),
    expiry,
    missing(t.lastWebLogin, user.lastLoginLocal && day(user.lastLoginLocal), t.never),
    ...(ipa ? [missing(t.lastKerberosLogin, ipa.lastLoginIpa && day(ipa.lastLoginIpa), t.neverTracked)] : []),
    ...(ipa?.employeeType ? [{ label: t.role, value: ipa.employeeType }] : []),
    ...(ipa?.mobile && ipa.mobile !== ipa.phone ? [{ label: t.mobile, value: ipa.mobile }] : []),
    ...(address ? [{ label: t.address, value: address }] : []),
  ];
  const blocked = isExpired || !categoryPolicy[category].enabled;

  const record: UserRecordView = {
    user,
    title,
    image: cloudAvatarImage({ kind: "user", userId: user.id, avatarHash: user.avatarHash }),
    kinds: [
      accountCategoryLabel(user, categoryPolicy.login.label),
      ...getSupplementalRoles(user).map((role) => (role === "group-manager" ? t.groupManager : t.admin)),
    ],
    expired: isExpired,
    expires: user.accountExpires ? day(user.accountExpires) : null,
    facts,
    sshFingerprints: ipa?.sshFingerprints ?? [],
    linux: linux.user.identity || linux.user.provider === "ipa" || (linux.config.enabled && linux.user.profile === "user") ? linux : null,
    memberships: (recursive ? allGroups : directGroups).map(groupView),
    directCount: directGroups.length,
    allCount: allGroups.length,
    managed: managedGroupsPage.items.map(groupView),
    memberGroupIds: [...new Set([...allGroups.map((group) => group.id), ...direct])],
    keys: apiKeysPage.items.map((key) => ({
      id: key.id,
      name: key.name,
      tokenPrefix: key.tokenPrefix,
      modelsOnly: isModelsOnlyApiKey(key),
      created: moment(key.createdAt),
      expires: key.expiresAt ? moment(key.expiresAt) : null,
      lastUsed: key.lastUsedAt ? moment(key.lastUsedAt) : null,
    })),
    keysTotal: apiKeysPage.total,
    keysHref: `/app/accounts/api-keys?kind=user_delegated&status=active&search=${encodeURIComponent(user.uid)}`,
    signInDevices:
      devices?.map((device) => ({
        id: device.id,
        name: device.name,
        assisted: device.assisted,
        paired: moment(device.createdAt),
        lastUsed: device.lastUsedAt ? moment(device.lastUsedAt) : null,
      })) ?? null,
    appDevices:
      phones?.map((phone) => ({
        id: phone.id,
        name: phone.name,
        platform: phone.platform,
        paired: moment(phone.createdAt),
        lastUsed: moment(phone.lastUsedAt),
      })) ?? null,
    signInPairHref: approvalConfig?.enabled && approvalConfig.adminPairing && !blocked ? `/me/security/pair?userId=${user.id}` : null,
    cloudApp: {
      blocked,
      administrator: sessionUser.displayName?.trim() || sessionUser.uid,
      cloud: cloudName || "Cloud",
      name: user.displayName?.trim() || user.uid,
    },
    freeIpaEnabled: freeIpaEnabled === true,
    localEmailOptional: localEmailOptional === true,
  };

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.accounts, href: "/app/accounts" },
        // The way up keeps the list's filters this record was opened from.
        { title: t.users, href: listHref },
        { title: user.uid },
      ]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "users", pendingRequests, isAdmin: true })} />
      <UserScreen record={record} tab={tab} recursive={recursive} list={list} listHref={listHref} pendingRequests={pendingRequests} />
    </Layout>
  );
});
