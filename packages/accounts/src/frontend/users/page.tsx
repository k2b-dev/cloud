import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";
import { accountsAppService as accountsService } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { toAccountsActor } from "../../shared/actor";
import AccountsNavigation from "../AccountsNavigation.island";
import { accountsNavigationItems } from "../accounts-nav";
import { listMessages } from "../list-messages";
import { accountsMessages } from "../messages";
import {
  directoryQueryOf,
  isUserView,
  legacyUsersHref,
  parseUsersAddress,
  USER_VIEWS,
  USERS_PER_PAGE,
  usersHref,
  usersQuery,
} from "./query";
import UsersScreen from "./UsersScreen.island";

/** The users of this Cloud on v2. The address is the whole list state: the declaration in `query.ts` reads it. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const timeZone = getTimeZone(c);
  const actor = toAccountsActor(expectUserBackedActor(c));
  const url = new URL(c.req.url);
  // Addresses from before v2 (`search`, `profile`) lead to the same list in the v2 address.
  const legacy = legacyUsersHref(url.searchParams);
  if (legacy) return c.redirect(legacy);

  const query = usersQuery(locale);
  const address = parseUsersAddress(query, url.searchParams);
  const view = address.state.view;
  // A view named alone opens with its whole query, so the address always holds the state.
  if (isUserView(view) && [...url.searchParams.keys()].every((name) => name === "view"))
    return c.redirect(usersHref(query, USER_VIEWS[view](query)));

  const now = new Date();
  const groupIds = address.state.filters["member-of"];
  const [pendingRequests, list, groups] = await Promise.all([
    accountsService.accountRequest.countPending(),
    accountsService.user
      .directory({ actor, ...directoryQueryOf(address.state, timeZone, now), pagination: { page: address.page, perPage: USERS_PER_PAGE } })
      .then((result) => (result.ok ? result.data : null))
      .catch(() => null),
    groupIds
      ? accountsService.group.list({ pagination: { page: 1, perPage: groupIds.length }, scope: { mode: "all", ids: [...groupIds] } })
      : null,
  ]);
  // A page past the end, after deletions or from an old link, opens the last page with the same filters.
  const pages = Math.max(1, Math.ceil((list?.total ?? 0) / USERS_PER_PAGE));
  if (list && address.page > pages) return c.redirect(usersHref(query, address.state, pages));

  const { t } = accountsMessages.resolve([locale]);
  const words = listMessages.resolve([locale]).t;
  const ignored =
    address.issues.length > 0
      ? words.ignoredPartsDetail({
          params: address.issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.code)).join(", "),
        })
      : null;
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.users }]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "users", pendingRequests, isAdmin: true })} />
      <UsersScreen
        state={address.state}
        page={address.page}
        entries={list?.items ?? null}
        total={list?.total ?? 0}
        groupNames={(groups?.items ?? []).map((group) => ({ value: group.id, label: group.name }))}
        ignored={ignored}
        now={now.toISOString()}
        timeZone={timeZone}
        pendingRequests={pendingRequests}
      />
    </Layout>
  );
});
