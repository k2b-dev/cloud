import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { parseUsersAddress, usersQuery } from "./query";
import UsersScreen from "./UsersScreen";
import { FIXTURE_GROUPS, FIXTURE_NOW, FIXTURE_TIME_ZONE, fixtureDirectory } from "./users-screen.fixture";

/**
 * The user list for a browser test, rendered as the server would render it for the page's address: the address is
 * parsed with the same declaration and the sample people are filtered like the directory query. The test answers the
 * users and groups API from the same sample.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const failed = document.documentElement.dataset.failed === "true";
const address = parseUsersAddress(usersQuery("de"), new URLSearchParams(location.search));
const entries = fixtureDirectory(address.state);
render(
  () => (
    <LocaleProvider locale="de">
      <UsersScreen
        state={address.state}
        page={address.page}
        entries={failed ? null : entries}
        total={failed ? 0 : entries.length}
        groupNames={Object.values(FIXTURE_GROUPS)
          .filter((group) => address.state.filters["member-of"]?.includes(group.id))
          .map((group) => ({ value: group.id, label: group.name }))}
        ignored={null}
        now={FIXTURE_NOW}
        timeZone={FIXTURE_TIME_ZONE}
        pendingRequests={2}
      />
    </LocaleProvider>
  ),
  host,
);
