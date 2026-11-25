import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import UserScreen from "./UserScreen";
import { type FixtureName, fixtureRecord } from "./user-record.fixture";
import { userTabFrom } from "./user-view";

/**
 * A user's record for a browser test, rendered as the server renders it for the page's address: `?tab=` and
 * `?recursive=true` choose the area, `<html data-fixture>` the invented record. The test answers the API itself.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const params = new URLSearchParams(location.search);
const recursive = params.get("recursive") === "true";
const fixture = (document.documentElement.dataset.fixture ?? "sample") as FixtureName;
const record = fixtureRecord(fixture);
const list = params.get("list") ?? "";

render(
  () => (
    <LocaleProvider locale="de">
      <UserScreen
        record={{ ...record, memberships: recursive ? record.memberships : record.memberships.filter((group) => group.direct) }}
        tab={userTabFrom(params.get("tab") ?? undefined, recursive)}
        recursive={recursive}
        list={list}
        listHref={list ? `/app/accounts/users?${list}` : "/app/accounts/users"}
        pendingRequests={2}
      />
    </LocaleProvider>
  ),
  host,
);
