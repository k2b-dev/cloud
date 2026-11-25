import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import GroupsScreen from "../groups/GroupsScreen";
import { groupsQuery, parseGroupsAddress } from "../groups/query";
import { parseUsersAddress, USERS_PER_PAGE, usersQuery } from "./query";
import UsersScreen from "./UsersScreen";
import { FIXTURE_GROUPS, FIXTURE_NOW, FIXTURE_TIME_ZONE, fixtureDirectory, fixtureSample } from "./users-screen.fixture";

/**
 * The account and group lists for a browser test, rendered as the server would render them for the page's address: the
 * address is parsed with the same declaration and the sample is filtered like the service does. The test answers the
 * users and groups API from the same sample.
 */
// what the list costs once its code is there: from here (the server's answer included) to the rendered rows
performance.mark("accounts-start");
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const failed = document.documentElement.dataset.failed === "true";
const sample = fixtureSample(document.documentElement.dataset.sample);
const params = new URLSearchParams(location.search);

const users = () => {
  const address = parseUsersAddress(usersQuery("de"), params);
  // the server pages the list: one page of the matching accounts, and how many match in all
  const matching = fixtureDirectory(address.state, sample);
  const entries = matching.slice((address.page - 1) * USERS_PER_PAGE, address.page * USERS_PER_PAGE);
  return (
    <UsersScreen
      state={address.state}
      page={address.page}
      entries={failed ? null : entries}
      total={failed ? 0 : matching.length}
      groupNames={Object.values(FIXTURE_GROUPS)
        .filter((group) => address.state.filters["member-of"]?.includes(group.id))
        .map((group) => ({ value: group.id, label: group.name }))}
      ignored={null}
      now={FIXTURE_NOW}
      timeZone={FIXTURE_TIME_ZONE}
      pendingRequests={2}
    />
  );
};

// keyed by the sample groups' IDs; the German names stay display text
const descriptions = new Map<string, string>([
  [FIXTURE_GROUPS.office.id, "Empfang, Post und Termine"],
  [FIXTURE_GROUPS.sales.id, "Ankauf und Verkauf im Laden und online"],
  [FIXTURE_GROUPS.store.id, "Wareneingang, Lagerorte und Versand"],
]);

const groups = () => {
  const address = parseGroupsAddress(groupsQuery("de", "all"), params);
  const search = address.state.search?.toLowerCase();
  const rows = Object.values(FIXTURE_GROUPS)
    .filter((group) => !search || group.name.toLowerCase().includes(search))
    .sort((a, b) => a.name.localeCompare(b.name, "de"))
    .map((group, index) => ({
      id: group.id,
      name: group.name,
      description: descriptions.get(group.id) ?? null,
      provider: index % 3 === 2 ? ("ipa" as const) : ("local" as const),
      posix: index % 2 === 0,
      managed: group.name === "Lager",
      href: `/app/accounts/groups/${group.id}?list_scope=all`,
    }));
  return (
    <GroupsScreen
      state={address.state}
      defaultScope="all"
      page={1}
      pages={1}
      total={rows.length}
      groups={rows}
      isAdmin
      freeIpaEnabled
      linuxEnabled
      pendingRequests={2}
      ignored={null}
    />
  );
};

render(() => <LocaleProvider locale="de">{location.pathname.endsWith("/groups") ? groups() : users()}</LocaleProvider>, host);
performance.mark("accounts-ready");
