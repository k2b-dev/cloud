import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService, coreSettings, linuxIdentities } from "@k2b/cloud/services";
import { getDefaultGroupScope, groupDisplayName, isAdminUser } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import AccountsNavigation from "../AccountsNavigation.island";
import { accountsNavigationItems } from "../accounts-nav";
import { buildGroupDetailUrl } from "../lib/url-state";
import { listMessages } from "../list-messages";
import { accountsMessages } from "../messages";
import GroupsScreen from "./GroupsScreen.island";
import { GROUPS_PER_PAGE, groupsHref, groupsListState, groupsQuery, legacyGroupsHref, parseGroupsAddress } from "./query";

/** The groups on v2. The address is the whole list state: the declaration in `query.ts` reads it, the service filters. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = accountsMessages.resolve([locale]);
  const sessionUser = expectUserBackedActor(c);
  const isAdmin = isAdminUser(sessionUser);
  const defaultScope = getDefaultGroupScope(sessionUser);
  const query = groupsQuery(locale, defaultScope);
  const url = new URL(c.req.url);
  // Addresses from before v2 (`search`, the former `personal` filter) lead to the same list in the v2 address.
  const legacy = legacyGroupsHref(query, url.searchParams);
  if (legacy) return c.redirect(legacy);

  const address = parseGroupsAddress(query, url.searchParams);
  const listState = groupsListState(address.state, address.page);
  const [freeIpaEnabled, linuxEnabled, groupsPage, pendingRequests] = await Promise.all([
    coreSettings.get<boolean>("freeipa.enable").then(Boolean),
    isAdmin ? linuxIdentities.configuration(sessionUser).then((config) => config.enabled) : false,
    accountsService.group.list({
      pagination: { page: address.page, perPage: GROUPS_PER_PAGE },
      filter: { search: address.state.search },
      scope: {
        userId: listState.scope === "all" ? undefined : sessionUser.id,
        mode: listState.scope,
        provider: listState.provider || undefined,
      },
    }),
    isAdmin ? accountsService.accountRequest.countPending() : 0,
  ]);
  const pages = Math.max(1, Math.ceil(groupsPage.total / GROUPS_PER_PAGE));
  // Deleting a group, or an old link, can leave the requested page past the end; open the last page instead.
  if (address.page > pages) return c.redirect(groupsHref(query, address.state, pages));

  const words = listMessages.resolve([locale]).t;
  const ignored =
    address.issues.length > 0
      ? words.ignoredPartsDetail({
          params: address.issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.code)).join(", "),
        })
      : null;
  const groups = groupsPage.items.map((group) => ({
    id: group.id,
    name: groupDisplayName(group.name, locale),
    description: group.description,
    provider: group.provider,
    posix: Boolean(group.gidnumber),
    managed: sessionUser.managesGroupIds.includes(group.id),
    personal: group.personalOwner !== null,
    href: buildGroupDetailUrl(group.id, listState, { defaultScope }),
  }));

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.groups }]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "groups", pendingRequests, isAdmin })} />
      <GroupsScreen
        state={address.state}
        defaultScope={defaultScope}
        page={address.page}
        pages={pages}
        total={groupsPage.total}
        groups={groups}
        isAdmin={isAdmin}
        freeIpaEnabled={freeIpaEnabled}
        linuxEnabled={linuxEnabled}
        pendingRequests={pendingRequests}
        ignored={ignored}
      />
    </Layout>
  );
});
