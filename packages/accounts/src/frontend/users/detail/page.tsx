import { cloudAvatarImage } from "@k2b/cloud/account/ui";
import { accountCategory, accountCategoryLabel } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";
import {
  accountsAppService as accountsService,
  appApproval,
  audit,
  coreSettings,
  linuxIdentities,
  pwaDevices,
  readAccountCategoryPolicy,
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
import { auditMessages } from "../../audit/messages";
import { auditRows } from "../../audit/rows";
import { getSupplementalRoles } from "../../lib/account-badges";
import { accountsMessages } from "../../messages";
import { firstKeyPage } from "../../service-accounts/account-keys.server";
import { usersListContext, usersListHref, usersQuery } from "../query";
import { isResourceRecordKind, renderResourceRecord } from "./resource-record";
import UserScreen from "./UserScreen.island";
import type { UserFact, UserGroupView, UserRecordView } from "./user-view";
import { GROUPS_PAGE, groupsPageFrom, userTabFrom } from "./user-view";

/** Events the overview shows of what was done to the account; the audit log holds the rest. */
const ACTIVITY_ROWS = 5;
/** Direct groups the overview shows; the groups tab lists them all. */
const OVERVIEW_GROUPS = 6;

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
 * memberships include inherited groups (`?recursive=true`), so reload, back and forward show the same page. The
 * server reads the head and the open tab only, in two rounds (who the id is, then everything else at once); a tab is
 * a link that loads its own data here, so the first picture has no loading state.
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

  // Round 1: who the id is, and the badge every kind shows.
  const [user, pendingRequests] = await Promise.all([accountsService.user.get({ id }), accountsService.accountRequest.countPending()]);
  if (!user) {
    // Not a person: the record opens an agent (as the agent page did) or an app's API key account (as the API key page
    // did), both through the same service read on this administrators' route; any other kind (code, a person's own
    // keys) and an unknown id stay the 404 of before.
    const account = await serviceAccounts.get({ id });
    if (account && isAgentRecordKind(account)) return renderAgentRecord(c, account, pendingRequests);
    if (account && isResourceRecordKind(account)) return renderResourceRecord(c, account, pendingRequests);
    return ssr.error(c, 404, { action: { label: t.backToUsers, href: listHref } });
  }

  // Round 2, all at once: the head's settings and the open tab's data, nothing of the other tabs.
  const timeZone = getTimeZone(c);
  const now = new Date();
  const direct = (perPage: number) =>
    accountsService.group.list({ pagination: { page: 1, perPage }, scope: { userId: id, mode: "direct" } });
  const groupView =
    (directIds: Set<string>) =>
    (group: BaseGroup): UserGroupView => ({
      id: group.id,
      name: group.name,
      description: group.description,
      provider: group.provider,
      direct: directIds.has(group.id),
    });
  const moment = (value: string) => dates.formatDateTime(value, { locale });
  // the policy of the account categories, read once for the head and, on the overview, for its facts
  const categoryPolicy = readAccountCategoryPolicy();
  const factsOf = (categories: Awaited<ReturnType<typeof readAccountCategoryPolicy>>): UserFact[] => {
    const ipa = user.provider === "ipa" ? user.ipa : null;
    const subject = user;
    const expired = subject.accountExpires ? new Date(subject.accountExpires) < now : false;
    const missing = (label: string, value: string | null | undefined, empty: string): UserFact =>
      value ? { label, value } : { label, value: empty, missing: true };
    const expiryLabel = subject.profile === "guest" && !ipa ? t.guestExpires : t.accountExpires;
    const expiry: UserFact = subject.accountExpires
      ? { label: expiryLabel, value: `${dates.formatDate(subject.accountExpires, { locale })}${expired ? t.expiredSuffix : ""}`, overdue: expired }
      : { label: expiryLabel, value: t.never, missing: true };
    const address = ipa ? formatAddress(ipa.address) : null;
    const date = (value: string) => dates.formatDate(value, { locale });
    return [
      { label: "UID", value: subject.uid, mono: true, copy: true },
      { label: t.databaseId, value: subject.id, mono: true, copy: true },
      { label: t.accountType, value: accountCategoryLabel(subject, categories.login.label) },
      { label: t.access, value: subject.profile === "user" ? t.fullAccount : t.guestAccount },
      subject.mail ? { label: t.email, value: subject.mail, copy: true } : { label: t.email, value: t.notSet, missing: true },
      ...(ipa ? [missing(t.passwordExpires, ipa.passwordExpires && date(ipa.passwordExpires), t.never)] : []),
      expiry,
      missing(t.lastWebLogin, subject.lastLoginLocal && date(subject.lastLoginLocal), t.never),
      ...(ipa ? [missing(t.lastKerberosLogin, ipa.lastLoginIpa && date(ipa.lastLoginIpa), t.neverTracked)] : []),
      ...(ipa?.employeeType ? [{ label: t.role, value: ipa.employeeType }] : []),
      ...(ipa?.mobile && ipa.mobile !== ipa.phone ? [{ label: t.mobile, value: ipa.mobile }] : []),
      ...(address ? [{ label: t.address, value: address }] : []),
    ];
  };

  const areaOf = async (): Promise<UserRecordView["area"]> => {
    if (tab === "groups") {
      const page = groupsPageFrom(c.req.query("page"));
      // one page of the memberships: the direct ones, or with inherited ones when the address asks for them
      const membersOf = (mode: "direct" | "member") =>
        accountsService.group.list({ pagination: { page, perPage: GROUPS_PAGE }, scope: { userId: id, mode } });
      const [membersPage, directIdsOfPage, managedPage] = await Promise.all([
        membersOf(recursive ? "member" : "direct"),
        // which of an inherited page's groups are direct: the person's direct group ids (only with `recursive`)
        recursive ? accountsService.user.groupId.list({ userId: id, recursive: false }) : null,
        accountsService.group.list({ pagination: { page: 1, perPage: GROUPS_PAGE }, scope: { userId: id, mode: "managed" } }),
      ]);
      const directIds = new Set(directIdsOfPage ?? membersPage.items.map((group) => group.id));
      return {
        tab,
        memberships: membersPage.items.map(groupView(directIds)),
        total: membersPage.total,
        page,
        pages: Math.max(1, Math.ceil(membersPage.total / GROUPS_PAGE)),
        managed: managedPage.items.map(groupView(new Set())),
        managedTotal: managedPage.total,
      };
    }
    if (tab === "keys") {
      const [keys, modelsAvailable] = await Promise.all([
        // the person's own keys: the first page the key section pages on from, through the same service as before
        firstKeyPage({ kind: "person", userId: id }, { locale, timeZone, now }, c.req.query("key")),
        coreSettings.get<boolean>("ai.openai_api_enabled"),
      ]);
      return { tab, keys, modelsAvailable: modelsAvailable === true, timeZone };
    }
    if (tab === "devices") {
      const [devices, phones, approvalConfig, cloudName] = await Promise.all([
        // Null shows "could not be loaded" instead of hiding a device an administrator may need to revoke.
        appApproval.listUserDevices({ userId: sessionUser.id, admin }, id).catch(() => null),
        pwaDevices.listUserDevices({ userId: sessionUser.id, admin }, id).catch(() => null),
        appApproval.config().catch(() => null),
        coreSettings.get<string>("app.name"),
      ]);
      const blocked = (user.accountExpires ? new Date(user.accountExpires) < now : false) || !(await categoryPolicy)[accountCategory(user)].enabled;
      return {
        tab,
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
        cloud: cloudName || "Cloud",
      };
    }
    const [directPage, linux, events] = await Promise.all([
      direct(OVERVIEW_GROUPS),
      linuxIdentities.get(sessionUser, id),
      // one statement, no count: the section shows the newest few and links on to the log
      audit.latest({ target: { type: "user", id }, limit: ACTIVITY_ROWS }).catch(() => null),
    ]);
    const auditWords = auditMessages.resolve([locale]).t;
    return {
      tab: "overview",
      facts: factsOf(await categoryPolicy),
      sshFingerprints: user.provider === "ipa" ? user.ipa.sshFingerprints : [],
      linux: linux.user.identity || linux.user.provider === "ipa" || (linux.config.enabled && linux.user.profile === "user") ? linux : null,
      directGroups: directPage.items.map(groupView(new Set(directPage.items.map((group) => group.id)))),
      directCount: directPage.total,
      activity: events
        ? auditRows(events, { t, locale, timeZone, now, today: auditWords.today, yesterday: auditWords.yesterday, names: [] }).map(
            (row) => ({
              actor: row.actor.label,
              actorImage: row.actor.userId ? cloudAvatarImage({ kind: "user", userId: row.actor.userId }) : undefined,
              action: row.action.label,
              when: `${row.day}, ${row.time}`,
            }),
          )
        : null,
    };
  };
  const [policy, freeIpaEnabled, localEmailOptional, area] = await Promise.all([
    categoryPolicy,
    coreSettings.get<boolean>("freeipa.enable"),
    coreSettings.get<boolean>("user.local_email_optional"),
    areaOf(),
  ]);

  const isExpired = user.accountExpires ? new Date(user.accountExpires) < now : false;
  const day = (value: string) => dates.formatDate(value, { locale });
  const title = user.displayName || user.mail || user.uid;
  const record: UserRecordView = {
    user,
    title,
    image: cloudAvatarImage({ kind: "user", userId: user.id, avatarHash: user.avatarHash }),
    kinds: [
      accountCategoryLabel(user, policy.login.label),
      ...getSupplementalRoles(user).map((role) => (role === "group-manager" ? t.groupManager : t.admin)),
    ],
    expired: isExpired,
    status: isExpired ? "expired" : user.lastLoginLocal ? "active" : "invited",
    lastSignIn: user.lastLoginLocal ? moment(user.lastLoginLocal) : null,
    expires: user.accountExpires ? day(user.accountExpires) : null,
    cloudApp: {
      blocked: isExpired || !policy[accountCategory(user)].enabled,
      administrator: sessionUser.displayName?.trim() || sessionUser.uid,
      name: user.displayName?.trim() || user.uid,
    },
    freeIpaEnabled: freeIpaEnabled === true,
    localEmailOptional: localEmailOptional === true,
    area,
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
